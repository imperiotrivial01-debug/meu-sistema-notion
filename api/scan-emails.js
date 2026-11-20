import tls from "tls";

// Varredura automática (a cada 10 dias via Vercel Cron) ou manual via portal
export default async function handler(req, res) {
  const APP_PASSWORD = process.env.APP_PASSWORD;
  const CRON_SECRET = process.env.CRON_SECRET;

  // Valida se veio do agendador automático da Vercel ou do utilizador autenticado
  const authHeader = req.headers["authorization"];
  const appPassHeader = req.headers["x-app-password"];
  const isCron = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  const isUser = APP_PASSWORD && appPassHeader === APP_PASSWORD;

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

    socket.setTimeout(15000);
    socket.on("timeout", () => { socket.destroy(); reject(new Error("Tempo limite excedido ao ligar ao e-mail.")); });
    socket.on("error", err => reject(err));

    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");

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
          uids = match[1].trim().split(/\s+/).slice(-25); // últimos 25 e-mails do ciclo de 10 dias
        }
        buffer = "";
        if (uids.length === 0) {
          socket.write("A99 LOGOUT\r\n");
          socket.end();
          return resolve([]);
        }
        step = 4;
        socket.write(`A4 FETCH ${uids[currentIdx]} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)] BODY.PEEK[TEXT]<0.2500>)\r\n`);
      } else if (step === 4 && buffer.includes("A4 OK")) {
        const assuntoMatch = buffer.match(/Subject:\s*(.+)/i);
        const deMatch = buffer.match(/From:\s*(.+)/i);
        const dataMatch = buffer.match(/Date:\s*(.+)/i);

        const assunto = assuntoMatch ? decodificarHeader(assuntoMatch[1].trim()) : "Documento sem assunto";
        const remetente = deMatch ? deMatch[1].trim().replace(/[<>"]/g, "") : "Remetente desconhecido";
        const textoLimpo = buffer.replace(/=\r?\n/g, "").replace(/<[^>]+>/g, " ");

        // Filtra apenas mensagens relacionadas com faturas, recibos, pagamentos ou cobranças
        if (/fatura|factura|invoice|recibo|pagamento|cobran|vencimento|total a pagar|extrato/i.test(assunto + " " + textoLimpo)) {
          const valorMatch = textoLimpo.match(/(?:€|EUR|Total|Valor)\s*:?\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})/i)
            || textoLimpo.match(/([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})\s*(?:€|EUR)/i);
          const valorNum = valorMatch
            ? parseFloat(valorMatch[1].replace(/\./g, "").replace(",", "."))
            : 0;

          const dataEmail = dataMatch ? new Date(dataMatch[1]) : new Date();
          const dataIso = !isNaN(dataEmail.getTime()) ? dataEmail.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

          resultados.push({
            uid: uids[currentIdx],
            descricao: assunto.slice(0, 90),
            remetente: remetente.slice(0, 60),
            valor: valorNum,
            data: dataIso
          });
        }

        buffer = "";
        currentIdx++;
        if (currentIdx < uids.length) {
          socket.write(`A4 FETCH ${uids[currentIdx]} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)] BODY.PEEK[TEXT]<0.2500>)\r\n`);
        } else {
          socket.write("A99 LOGOUT\r\n");
          socket.end();
          resolve(resultados);
        }
      } else if (buffer.includes("A1 NO") || buffer.includes("A1 BAD")) {
        socket.end();
        reject(new Error("Falha de autenticação IMAP. Verifique IMAP_USER e a Senha de Aplicação (App Password)."));
      }
    });
  });
}

function decodificarHeader(str) {
  return str.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b64) => Buffer.from(b64, "base64").toString("utf8"))
            .replace(/=\?UTF-8\?Q\?([^?]+)\?=/gi, (_, qp) => qp.replace(/_/g, " "));
}
