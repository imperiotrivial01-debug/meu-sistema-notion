import tls from "tls";
import zlib from "zlib";

export default async function handler(req, res) {
  const APP_USER = process.env.APP_USER;
  const APP_PASSWORD = process.env.APP_PASSWORD;
  const CRON_SECRET = process.env.CRON_SECRET;

  const authHeader = req.headers["authorization"];
  const appPassHeader = req.headers["x-app-password"] || "";
  const appUserHeader = (req.headers["x-app-user"] || "").trim().toLowerCase();

  const isCron = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  const isUser = APP_PASSWORD && appPassHeader === APP_PASSWORD && (!APP_USER || appUserHeader === APP_USER.trim().toLowerCase());

  if (!isCron && !isUser && (APP_PASSWORD || CRON_SECRET)) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  const IMAP_HOST = process.env.IMAP_HOST || "imap.gmail.com";
  const IMAP_PORT = parseInt(process.env.IMAP_PORT || "993", 10);
  const IMAP_USER = process.env.IMAP_USER;
  const IMAP_PASS = process.env.IMAP_PASS;

  if (!IMAP_USER || !IMAP_PASS) {
    return res.status(200).json({
      configured: false,
      message: "Configure IMAP_USER e IMAP_PASS na Vercel para ativar a leitura automática do e-mail.",
      faturas: []
    });
  }

  try {
    const faturas = await buscarFaturasImap({
      host: IMAP_HOST,
      port: IMAP_PORT,
      user: IMAP_USER,
      pass: IMAP_PASS,
      dias: 10
    });

    return res.status(200).json({
      configured: true,
      periodoDias: 10,
      verificadoEm: new Date().toISOString(),
      faturas
    });
  } catch (err) {
    return res.status(500).json({
      configured: true,
      error: "Erro ao ler caixa de e-mail: " + err.message,
      faturas: []
    });
  }
}

function buscarFaturasImap({ host, port, user, pass, dias }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(port, host, { rejectUnauthorized: false }, () => {});
    let buffer = "";
    let step = 0;
    let uids = [];
    let currentIdx = 0;
    const resultados = [];

    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - dias);
    const mesesEn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const sinceStr = `${String(dataLimite.getDate()).padStart(2, "0")}-${mesesEn[dataLimite.getMonth()]}-${dataLimite.getFullYear()}`;

    socket.setTimeout(20000);
    socket.on("timeout", () => { socket.destroy(); reject(new Error("Tempo limite excedido ao ligar ao e-mail.")); });
    socket.on("error", err => reject(err));

    socket.on("data", chunk => {
      buffer += chunk.toString("latin1");

      if (step === 0 && buffer.includes("* OK")) {
        buffer = "";
        step = 1;
        socket.write(`A1 LOGIN "${user}" "${pass}"\r\n`);
      } else if (step === 1 && buffer.includes("A1 OK")) {
        buffer = "";
        step = 2;
        socket.write(`A2 SELECT INBOX\r\n`);
      } else if (step === 2 && buffer.includes("A2 OK")) {
        buffer = "";
        step = 3;
        socket.write(`A3 SEARCH SINCE ${sinceStr}\r\n`);
      } else if (step === 3 && buffer.includes("A3 OK")) {
        const match = buffer.match(/\* SEARCH([0-9 ]*)/);
        if (match && match[1].trim()) {
          uids = match[1].trim().split(/\s+/).slice(-20);
        }
        buffer = "";
        if (uids.length === 0) {
          socket.write("A99 LOGOUT\r\n");
          socket.end();
          return resolve([]);
        }
        step = 4;
        // Lê o e-mail completo (até 450KB) para capturar anexos PDF
        socket.write(`A4 FETCH ${uids[currentIdx]} (BODY.PEEK[]<0.450000>)\r\n`);
      } else if (step === 4 && /\r\nA4 OK/.test(buffer)) {
        const assuntoMatch = buffer.match(/^Subject:\s*(.+)$/im);
        const deMatch = buffer.match(/^From:\s*(.+)$/im);
        const dataMatch = buffer.match(/^Date:\s*(.+)$/im);

        const assunto = assuntoMatch ? decodificarHeader(assuntoMatch[1].trim()) : "Documento sem assunto";
        const remetente = deMatch ? decodificarHeader(deMatch[1].trim()).replace(/[<>"]/g, "") : "Remetente desconhecido";

        // Deteta anexo PDF em Base64
        const pdfInfo = extrairPdfDoMime(buffer);
        const textoCorpo = buffer.slice(0, 15000).replace(/=\r?\n/g, "").replace(/<[^>]+>/g, " ");
        const textoCombinado = `${assunto} ${pdfInfo.nomeArquivo} ${textoCorpo} ${pdfInfo.textoExtraido}`;

        // Identifica FT (Fatura), Factura, Invoice, Recibo, etc.
        const isFatura = /\bft\b|ft[\s\-_\/]*[0-9]|fatura|factura|invoice|recibo|nota de cr[eé]dito|pagamento|total a pagar/i.test(textoCombinado);

        if (isFatura) {
          // Prioriza extrair o valor de dentro do texto do PDF, depois do corpo do e-mail
          const valorNum = extrairValorMonetario(pdfInfo.textoExtraido) || extrairValorMonetario(textoCorpo) || 0;

          const dataEmail = dataMatch ? new Date(dataMatch[1]) : new Date();
          const dataIso = !isNaN(dataEmail.getTime()) ? dataEmail.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

          resultados.push({
            uid: uids[currentIdx],
            descricao: assunto.slice(0, 95),
            remetente: remetente.slice(0, 65),
            valor: valorNum,
            data: dataIso,
            nomeArquivoPdf: pdfInfo.nomeArquivo || "",
            pdfBase64: pdfInfo.base64Limpo && pdfInfo.base64Limpo.length < 350000 ? pdfInfo.base64Limpo : ""
          });
        }

        buffer = "";
        currentIdx++;
        if (currentIdx < uids.length) {
          socket.write(`A4 FETCH ${uids[currentIdx]} (BODY.PEEK[]<0.450000>)\r\n`);
        } else {
          socket.write("A99 LOGOUT\r\n");
          socket.end();
          resolve(resultados);
        }
      } else if (buffer.includes("A1 NO") || buffer.includes("A1 BAD")) {
        socket.end();
        reject(new Error("Falha de autenticação IMAP. Verifique IMAP_USER e a Senha de Aplicação."));
      }
    });
  });
}

function extrairPdfDoMime(rawMime) {
  const nomeMatch = rawMime.match(/filename="?([^"\r\n;]+\.pdf)"?/i) || rawMime.match(/name="?([^"\r\n;]+\.pdf)"?/i);
  if (!nomeMatch) return { nomeArquivo: "", textoExtraido: "", base64Limpo: "" };

  const nomeArquivo = decodificarHeader(nomeMatch[1].trim());
  const idxNome = rawMime.indexOf(nomeMatch[0]);
  const trechoAposCabecalho = rawMime.slice(idxNome);
  const inicioBase64 = trechoAposCabecalho.indexOf("\r\n\r\n");
  if (inicioBase64 === -1) return { nomeArquivo, textoExtraido: "", base64Limpo: "" };

  const corpoAnexo = trechoAposCabecalho.slice(inicioBase64 + 4);
  const fimBoundary = corpoAnexo.indexOf("\r\n--");
  const base64Bruto = fimBoundary !== -1 ? corpoAnexo.slice(0, fimBoundary) : corpoAnexo;
  const base64Limpo = base64Bruto.replace(/[^A-Za-z0-9+/=]/g, "");

  let textoExtraido = "";
  try {
    const pdfBuf = Buffer.from(base64Limpo, "base64");
    textoExtraido = extrairTextoDeBufferPdf(pdfBuf);
  } catch (e) {
    textoExtraido = "";
  }

  return { nomeArquivo, textoExtraido, base64Limpo };
}

function extrairTextoDeBufferPdf(pdfBuf) {
  const rawStr = pdfBuf.toString("latin1");
  let textos = [];

  // Descomprime streams FlateDecode internos do PDF para ler os números e palavras
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRegex.exec(rawStr)) !== null) {
    try {
      const compBuf = Buffer.from(match[1], "latin1");
      const inflated = zlib.inflateSync(compBuf).toString("latin1");
      const tjMatches = inflated.match(/\(([^()\\]*)\)\s*Tj|\[(.*?)\]\s*TJ/g) || [];
      for (const item of tjMatches) {
        const limpo = item.replace(/\[|\]|\(|\)|Tj|TJ/g, " ").replace(/\s+/g, " ").trim();
        if (limpo) textos.push(limpo);
      }
    } catch (_) {
      // Ignora streams de imagem ou fontes não comprimidas
    }
  }

  return textos.join(" ");
}

function extrairValorMonetario(texto) {
  if (!texto) return 0;
  // Procura padrões próximos de Total, Valor a Pagar, Líquido ou símbolo € / EUR
  const padroesPrioritarios = [
    /(?:total\s*(?:geral|a\s*pagar|fatura|documento|liquido|l[ií]quido)?|valor\s*(?:total|a\s*pagar)?|montante)\s*:?\s*(?:€|EUR)?\s*([0-9]{1,3}(?:[.\s][0-9]{3})*[.,][0-9]{2})/gi,
    /([0-9]{1,3}(?:[.\s][0-9]{3})*[.,][0-9]{2})\s*(?:€|EUR)/gi
  ];

  let maiorValor = 0;
  for (const regex of padroesPrioritarios) {
    let m;
    while ((m = regex.exec(texto)) !== null) {
      const numStr = m[1].replace(/\s/g, "").replace(/\.(?=[0-9]{3}[.,])/g, "").replace(",", ".");
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > maiorValor && val < 10000000) {
        maiorValor = val;
      }
    }
    if (maiorValor > 0) return maiorValor;
  }
  return 0;
}

function decodificarHeader(str) {
  return str.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b64) => Buffer.from(b64, "base64").toString("utf8"))
            .replace(/=\?UTF-8\?Q\?([^?]+)\?=/gi, (_, qp) => qp.replace(/_/g, " "));
}
