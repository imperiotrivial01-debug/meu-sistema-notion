import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_USERS_ID = process.env.NOTION_USERS_ID;
  const APP_USER = process.env.APP_USER;
  const APP_PASSWORD = process.env.APP_PASSWORD;

  const headers = {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
  };

  // 0. DEFINIR SENHA NO PRIMEIRO ACESSO (?setup=1)
  if (req.method === "POST" && req.query.setup === "1") {
    try {
      const { username, newPassword } = req.body || {};
      const userClean = (username || "").trim().toLowerCase();

      if (!userClean || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: "Indique o utilizador autorizado e uma senha com pelo menos 4 caracteres." });
      }
      if (!NOTION_USERS_ID) {
        return res.status(500).json({ error: "Tabela de Utilizadores (NOTION_USERS_ID) não configurada na Vercel." });
      }

      const userPage = await buscarUtilizadorNotion(NOTION_USERS_ID, userClean, headers);
      if (!userPage) {
        return res.status(404).json({ error: "Utilizador não encontrado. Peça ao administrador para adicionar o seu nome no Notion primeiro." });
      }
      if (userPage.senhaHash) {
        return res.status(403).json({ error: "Este utilizador já definiu uma senha. Se esqueceu, peça ao administrador para limpar o campo Senha no Notion." });
      }

      const hash = hashSenha(newPassword);
      const patchRes = await fetch(`https://api.notion.com/v1/pages/${userPage.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            [userPage.colSenha]: { rich_text: [{ text: { content: hash } }] }
          }
        })
      });

      if (!patchRes.ok) {
        return res.status(500).json({ error: "Erro ao guardar a nova senha no Notion." });
      }

      return res.status(200).json({ ok: true, role: userPage.role });
    } catch (e) {
      return res.status(500).json({ error: "Falha interna ao definir senha." });
    }
  }

  // 1. AUTENTICAÇÃO
  let role = "admin";
  const userRecebido = (req.headers["x-app-user"] || req.body?.username || "").trim().toLowerCase();
  const senhaRecebida = (req.headers["x-app-password"] || req.body?.password || "");

  let autenticado = false;

  if (APP_PASSWORD && senhaRecebida === APP_PASSWORD && (!APP_USER || userRecebido === APP_USER.trim().toLowerCase())) {
    autenticado = true;
    role = "admin";
  }

  if (!autenticado && NOTION_USERS_ID && userRecebido && senhaRecebida) {
    const userPage = await buscarUtilizadorNotion(NOTION_USERS_ID, userRecebido, headers);
    if (userPage) {
      if (!userPage.senhaHash) {
        return res.status(401).json({ error: "Primeiro acesso pendente: clique em 'Definir minha senha' abaixo." });
      }
      if (userPage.senhaHash === hashSenha(senhaRecebida)) {
        autenticado = true;
        role = userPage.role;
      }
    }
  }

  if (!autenticado && (APP_PASSWORD || NOTION_USERS_ID)) {
    return res.status(401).json({ error: "Utilizador ou senha incorretos." });
  }

  if (req.query.auth === "1") {
    return res.status(200).json({ ok: true, role });
  }

  const tab = req.query.tab || "movimentos";

  if (role === "staff" && tab !== "movimentos") {
    return res.status(403).json({ error: "Acesso restrito a administradores." });
  }

  const databases = {
    movimentos: process.env.NOTION_DATABASE_ID,
    folha: process.env.NOTION_FOLHA_ID,
    orcamentos: process.env.NOTION_ORCAMENTOS_ID,
    saude: process.env.NOTION_SAUDE_ID
  };

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "NOTION_TOKEN não configurado na Vercel." });
  }

  // 6. SAÚDE FINANCEIRA COMPLETA (FUNCIONA MESMO SEM NOTION_SAUDE_ID E NÃO FALHA SE UM BLOCO DER ERRO)
  if (tab === "saude") {
    try {
      const [movRaw, folhaRaw] = await Promise.all([
        databases.movimentos ? consultarTodosRegistosNotion(databases.movimentos, headers).catch(() => []) : Promise.resolve([]),
        databases.folha ? consultarTodosRegistosNotion(databases.folha, headers).catch(() => []) : Promise.resolve([])
      ]);

      const movimentos = formatarListaPaginas(movRaw);
      const salarios = formatarListaPaginas(folhaRaw);
      const kpis = [];

      if (databases.saude) {
        try {
          const dbTest = await fetch(`https://api.notion.com/v1/databases/${databases.saude}/query`, {
            method: "POST",
            headers,
            body: JSON.stringify({})
          });

          if (dbTest.ok) {
            const dbData = await dbTest.json();
            extrairNumerosDePaginas(dbData.results || [], kpis);
          } else {
            const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${databases.saude}/children`, {
              method: "GET",
              headers
            });
            if (blocksRes.ok) {
              const blocksData = await blocksRes.json();
              for (const block of (blocksData.results || [])) {
                if (block.type === "child_database") {
                  const subResults = await consultarTodosRegistosNotion(block.id, headers).catch(() => []);
                  extrairNumerosDePaginas(subResults, kpis, block.child_database?.title);
                } else {
                  const conteudo = block[block.type];
                  const texto = conteudo?.rich_text ? conteudo.rich_text.map(t => t.plain_text).join("") : "";
                  if (texto && /\d/.test(texto) && texto.length < 90) {
                    const partes = texto.split(":");
                    if (partes.length >= 2) {
                      kpis.push({ indicador: partes[0].trim(), valor: partes.slice(1).join(":").trim(), grupo: "Indicador" });
                    } else {
                      kpis.push({ indicador: "Métrica", valor: texto.trim(), grupo: "Indicador" });
                    }
                  }
                }
              }
            }
          }
        } catch (_) {
          // Ignora erros na página opcional de KPIs para não bloquear o demonstrativo financeiro
        }
      }

      return res.status(200).json({
        mode: "saude_completa",
        movimentos,
        salarios,
        kpis,
        role
      });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao gerar relatórios de Saúde Financeira: " + e.message });
    }
  }

  const TARGET_ID = databases[tab];
  if (!TARGET_ID) {
    return res.status(400).json({ error: `ID da aba '${tab}' não configurado na Vercel.` });
  }

  // 2. ESTRUTURA DAS COLUNAS (?schema=1)
  if (req.method === "GET" && req.query.schema === "1") {
    try {
      const schemaRes = await fetch(`https://api.notion.com/v1/databases/${TARGET_ID}`, {
        method: "GET",
        headers
      });
      const schemaData = await schemaRes.json();

      if (!schemaRes.ok) {
        return res.status(schemaRes.status).json({ error: "Esta aba não aceita novos registos diretos." });
      }

      const campos = [];
      for (const [nome, def] of Object.entries(schemaData.properties)) {
        if (["title", "number", "date", "select", "status", "rich_text", "checkbox", "multi_select"].includes(def.type)) {
          let opcoes = [];
          if (def.type === "select" && def.select?.options) opcoes = def.select.options.map(o => o.name);
          if (def.type === "status" && def.status?.options) opcoes = def.status.options.map(o => o.name);
          if (def.type === "multi_select" && def.multi_select?.options) opcoes = def.multi_select.options.map(o => o.name);
          campos.push({ nome, tipo: def.type, opcoes });
        }
      }

      campos.sort((a, b) => (a.tipo === "title" ? -1 : b.tipo === "title" ? 1 : 0));
      return res.status(200).json({ campos });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao obter campos da tabela." });
    }
  }

  // 3. CRIAR NOVO REGISTO (POST)
  if (req.method === "POST") {
    try {
      const { valores, fromEmailInvoice } = req.body;
      let propsParaGravar = valores || {};

      if (fromEmailInvoice) {
        const schemaRes = await fetch(`https://api.notion.com/v1/databases/${TARGET_ID}`, { method: "GET", headers });
        const schemaData = await schemaRes.json();
        const mapped = {};

        for (const [colName, colDef] of Object.entries(schemaData.properties)) {
          if (colDef.type === "title") {
            mapped[colName] = fromEmailInvoice.descricao;
          } else if (colDef.type === "number" && !mapped._numSet) {
            mapped[colName] = Math.abs(parseFloat(fromEmailInvoice.valor) || 0);
            mapped._numSet = true;
          } else if (colDef.type === "date" && !mapped._dateSet) {
            mapped[colName] = fromEmailInvoice.data || new Date().toISOString().split("T")[0];
            mapped._dateSet = true;
          } else if ((colDef.type === "status" || colDef.type === "select") && /estado|status|situa/i.test(colName)) {
            const opts = (colDef.status?.options || colDef.select?.options || []).map(o => o.name);
            const match = opts.find(o => o.toLowerCase().includes(fromEmailInvoice.estado.toLowerCase()));
            mapped[colName] = match || fromEmailInvoice.estado;
          } else if ((colDef.type === "select" || colDef.type === "status") && /tipo|fluxo|natureza/i.test(colName)) {
            const opts = (colDef.status?.options || colDef.select?.options || []).map(o => o.name);
            const alvoTipo = fromEmailInvoice.tipo === "entrada" ? /entrada|receita|crédito/i : /saída|saida|despesa|débito/i;
            const matchTipo = opts.find(o => alvoTipo.test(o));
            if (matchTipo) mapped[colName] = matchTipo;
          } else if (colDef.type === "rich_text" && /obs|nota|origem|detalhe|anexo|doc/i.test(colName)) {
            const infoPdf = fromEmailInvoice.nomeArquivoPdf ? ` | Anexo PDF: ${fromEmailInvoice.nomeArquivoPdf}` : "";
            mapped[colName] = `Importado do e-mail (${fromEmailInvoice.remetente || "FT"})${infoPdf}`;
          }
        }
        delete mapped._numSet;
        delete mapped._dateSet;
        propsParaGravar = mapped;
      }

      const properties = await construirPropriedadesNotion(TARGET_ID, propsParaGravar, headers);

      const createRes = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent: { database_id: TARGET_ID },
          properties
        })
      });

      const createData = await createRes.json();
      if (!createRes.ok) {
        return res.status(createRes.status).json({ error: createData.message || "Erro ao gravar no Notion." });
      }

      return res.status(200).json({ ok: true, id: createData.id });
    } catch (error) {
      return res.status(500).json({ error: error.message || "Falha interna ao criar registo." });
    }
  }

  // 4. EDITAR REGISTO OU MARCAR COMO PAGO/RECEBIDO (PATCH)
  if (req.method === "PATCH") {
    try {
      const { pageId, valores, quickPaid } = req.body;
      if (!pageId) return res.status(400).json({ error: "ID do registo em falta." });

      let properties = {};
      if (quickPaid) {
        const schemaRes = await fetch(`https://api.notion.com/v1/databases/${TARGET_ID}`, { method: "GET", headers });
        const schemaData = await schemaRes.json();
        for (const [colName, colDef] of Object.entries(schemaData.properties)) {
          if (colDef.type === "status" || colDef.type === "select") {
            const opts = (colDef.status?.options || colDef.select?.options || []).map(o => o.name);
            const alvo = opts.find(o => /pag|conclu|recebid|liquid|done|ok/i.test(o));
            if (alvo) {
              properties[colName] = colDef.type === "status" ? { status: { name: alvo } } : { select: { name: alvo } };
              break;
            }
          } else if (colDef.type === "checkbox" && /pag|conclu|recebid|ok/i.test(colName)) {
            properties[colName] = { checkbox: true };
            break;
          }
        }
        if (Object.keys(properties).length === 0) {
          return res.status(400).json({ error: "Não foi encontrada uma coluna de Estado com opção 'Pago/Recebido'. Use o botão Editar." });
        }
      } else {
        properties = await construirPropriedadesNotion(TARGET_ID, valores, headers);
      }

      const patchRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties })
      });

      const patchData = await patchRes.json();
      if (!patchRes.ok) {
        return res.status(patchRes.status).json({ error: patchData.message || "Erro ao atualizar registo." });
      }

      return res.status(200).json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message || "Falha ao atualizar registo." });
    }
  }

  // 5. ARQUIVAR / APAGAR REGISTO (DELETE)
  if (req.method === "DELETE") {
    try {
      const pageId = req.query.id;
      if (!pageId) return res.status(400).json({ error: "ID do registo em falta." });

      const delRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ archived: true })
      });

      if (!delRes.ok) {
        const delData = await delRes.json();
        return res.status(delRes.status).json({ error: delData.message || "Erro ao arquivar registo." });
      }

      return res.status(200).json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: "Falha ao apagar registo." });
    }
  }

  // 7. LISTAR REGISTOS COM PAGINAÇÃO COMPLETA
  try {
    const todosResultados = await consultarTodosRegistosNotion(TARGET_ID, headers);
    const itensFormatados = formatarListaPaginas(todosResultados);
    res.status(200).json({ mode: "list", items: itensFormatados, role });
  } catch (error) {
    res.status(500).json({ error: error.message || "Falha ao conectar com o Notion." });
  }
}

function hashSenha(texto) {
  return crypto.createHash("sha256").update(String(texto)).digest("hex");
}

async function buscarUtilizadorNotion(usersDbId, usernameLower, headers) {
  const res = await fetch(`https://api.notion.com/v1/databases/${usersDbId}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({})
  });
  if (!res.ok) return null;
  const data = await res.json();

  for (const page of (data.results || [])) {
    let nomeUser = "";
    let senhaHash = "";
    let colSenha = "Senha";
    let role = "staff";

    for (const [colName, prop] of Object.entries(page.properties)) {
      if (prop.type === "title") {
        nomeUser = prop.title.map(t => t.plain_text).join("").trim().toLowerCase();
      } else if (prop.type === "rich_text" && /senha|pass|chave/i.test(colName)) {
        colSenha = colName;
        senhaHash = prop.rich_text.map(t => t.plain_text).join("").trim();
      } else if ((prop.type === "select" || prop.type === "status") && /perfil|role|acesso|tipo/i.test(colName)) {
        const val = (prop.select?.name || prop.status?.name || "").toLowerCase();
        if (/admin|total|s[oó]cio|gestor/i.test(val)) role = "admin";
      }
    }

    if (nomeUser === usernameLower) {
      return { id: page.id, nomeUser, senhaHash, colSenha, role };
    }
  }
  return null;
}

async function consultarTodosRegistosNotion(databaseId, headers) {
  let allResults = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const body = startCursor ? { start_cursor: startCursor, page_size: 100 } : { page_size: 100 };
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || "Erro na API do Notion");
    }

    allResults = allResults.concat(data.results || []);
    hasMore = Boolean(data.has_more);
    startCursor = data.next_cursor;
  }

  return allResults;
}

function formatarListaPaginas(results) {
  return results.map(page => {
    let titulo = "Sem título";
    let status = "";
    let categoria = "";
    let dataIso = page.created_time ? page.created_time.slice(0, 10) : "";
    let dataExplicit = false;
    let valorNumerico = 0;
    let valorPrioritarioDefinido = false;
    let tipoFluxo = "";
    let isPaidFlag = false;
    const colunas = [];
    const raw = {};

    for (const [nomeColuna, prop] of Object.entries(page.properties)) {
      if (prop.type === "title") {
        titulo = prop.title.map(t => t.plain_text).join("") || "Sem título";
        raw[nomeColuna] = titulo;
      } else if (prop.type === "status" && prop.status) {
        status = prop.status.name;
        raw[nomeColuna] = status;
      } else if (prop.type === "select" && prop.select) {
        const valSel = prop.select.name;
        raw[nomeColuna] = valSel;

        if (/tipo|fluxo|natureza|movimento|opera/i.test(nomeColuna) || /^(entrada|sa[ií]da|receita|despesa|cr[eé]dito|d[eé]bito)$/i.test(valSel.trim())) {
          if (/entrada|receita|cr[eé]dito|ganho|venda/i.test(valSel)) tipoFluxo = "entrada";
          if (/sa[ií]da|despesa|d[eé]bito|custo|gasto|pagamento|compra|imposto|sal[aá]rio/i.test(valSel)) tipoFluxo = "saida";
        }

        if (/cat|grupo|centro|cargo|funç|func|depart/i.test(nomeColuna)) {
          categoria = valSel;
        } else if (!status && !/tipo|fluxo|natureza/i.test(nomeColuna)) {
          status = valSel;
        }
        colunas.push({ nome: nomeColuna, valor: valSel, rawNum: null });
      } else if (prop.type === "number" && prop.number !== null) {
        raw[nomeColuna] = prop.number;
        const isColValorPrincipal = /valor|montante|total|sal[aá]rio|vencimento|l[ií]quido|realizado|import/i.test(nomeColuna);
        if (!valorPrioritarioDefinido && (isColValorPrincipal || valorNumerico === 0)) {
          valorNumerico = prop.number;
          if (isColValorPrincipal) valorPrioritarioDefinido = true;
        }
        if (!tipoFluxo) {
          if (/entrada|receita|cr[eé]dito/i.test(nomeColuna)) tipoFluxo = "entrada";
          if (/sa[ií]da|despesa|d[eé]bito|custo|gasto|sal[aá]rio|vencimento/i.test(nomeColuna)) tipoFluxo = "saida";
        }
        colunas.push({
          nome: nomeColuna,
          valor: prop.number.toLocaleString("pt-PT", { minimumFractionDigits: 2 }),
          rawNum: prop.number
        });
      } else if (prop.type === "date" && prop.date) {
        if (!dataExplicit) {
          dataIso = prop.date.start;
          dataExplicit = true;
        }
        raw[nomeColuna] = prop.date.start;
        colunas.push({ nome: nomeColuna, valor: prop.date.start, rawNum: null });
      } else if (prop.type === "rich_text" && prop.rich_text.length > 0) {
        const txt = prop.rich_text.map(t => t.plain_text).join("");
        raw[nomeColuna] = txt;
        colunas.push({ nome: nomeColuna, valor: txt, rawNum: null });
      } else if (prop.type === "checkbox") {
        raw[nomeColuna] = prop.checkbox;
        if (/pag|conclu|recebid|liquid/i.test(nomeColuna) && prop.checkbox) {
          isPaidFlag = true;
        }
        colunas.push({ nome: nomeColuna, valor: prop.checkbox ? "Sim" : "Não", rawNum: null });
      } else if (prop.type === "formula" && prop.formula) {
        const f = prop.formula;
        if (f.number !== undefined && f.number !== null && !valorPrioritarioDefinido && /valor|total|l[ií]quido|saldo|vencimento/i.test(nomeColuna)) {
          valorNumerico = f.number;
          valorPrioritarioDefinido = true;
        }
        const val = f.number !== undefined && f.number !== null
          ? f.number.toLocaleString("pt-PT", { minimumFractionDigits: 2 })
          : (f.string || (f.boolean !== undefined ? (f.boolean ? "Sim" : "Não") : ""));
        if (val !== "") colunas.push({ nome: nomeColuna, valor: val, rawNum: f.number ?? null });
      } else if (prop.type === "multi_select" && prop.multi_select.length > 0) {
        const ms = prop.multi_select.map(s => s.name);
        raw[nomeColuna] = ms.join(", ");
        if (!categoria) categoria = ms[0];
        colunas.push({ nome: nomeColuna, valor: ms.join(", "), rawNum: null });
      }
    }

    if (!tipoFluxo) {
      if (valorNumerico < 0) {
        tipoFluxo = "saida";
      } else if (/despesa|sa[ií]da|pagamento|fornecedor|imposto|iva|irc|ss|seguran[cç]a social|renda|luz|agua|[aá]gua|net|telefone|sal[aá]rio|vencimento|compra|fatura fornecedor/i.test(`${titulo} ${categoria} ${status}`)) {
        tipoFluxo = "saida";
      } else if (/recebid|a receber|cliente|venda|receita|entrada|servi[cç]o|fatura cliente/i.test(`${titulo} ${categoria} ${status}`)) {
        tipoFluxo = "entrada";
      } else {
        tipoFluxo = "saida";
      }
    }

    const isSettled = isPaidFlag || /pag[oa]|conclu[ií]d|recebid[oa]|liquid|done|efetuad/i.test(status || "");

    return {
      id: page.id,
      titulo,
      status: status || (isSettled ? (tipoFluxo === "entrada" ? "Recebido" : "Pago") : "Pendente"),
      isSettled,
      categoria: categoria || "Geral",
      dataIso,
      valorNumerico: Math.abs(valorNumerico),
      tipoFluxo,
      colunas,
      raw
    };
  });
}

async function construirPropriedadesNotion(TARGET_ID, valores, headers) {
  const schemaRes = await fetch(`https://api.notion.com/v1/databases/${TARGET_ID}`, {
    method: "GET",
    headers
  });
  const schemaData = await schemaRes.json();

  if (!schemaRes.ok) {
    throw new Error(schemaData.message || "Erro ao validar tabela.");
  }

  const properties = {};
  for (const [colName, colDef] of Object.entries(schemaData.properties)) {
    const val = valores[colName];
    if (val === undefined || val === "" || val === null) continue;

    if (colDef.type === "title") {
      properties[colName] = { title: [{ text: { content: String(val) } }] };
    } else if (colDef.type === "number" && !isNaN(parseFloat(val))) {
      properties[colName] = { number: parseFloat(val) };
    } else if (colDef.type === "date") {
      properties[colName] = { date: { start: val } };
    } else if (colDef.type === "select") {
      properties[colName] = { select: { name: String(val).trim() } };
    } else if (colDef.type === "status") {
      properties[colName] = { status: { name: String(val).trim() } };
    } else if (colDef.type === "multi_select") {
      const lista = Array.isArray(val) ? val : String(val).split(",").map(s => s.trim()).filter(Boolean);
      properties[colName] = { multi_select: lista.map(name => ({ name })) };
    } else if (colDef.type === "rich_text") {
      properties[colName] = { rich_text: [{ text: { content: String(val) } }] };
    } else if (colDef.type === "checkbox") {
      properties[colName] = { checkbox: Boolean(val) };
    }
  }
  return properties;
}

function extrairNumerosDePaginas(pages, kpis, nomeTabela = "") {
  for (const page of pages) {
    let nomeLinha = nomeTabela || "Indicador";
    for (const [, prop] of Object.entries(page.properties)) {
      if (prop.type === "title" && prop.title.length > 0) {
        nomeLinha = prop.title.map(t => t.plain_text).join("");
      }
    }

    for (const [colName, prop] of Object.entries(page.properties)) {
      if (prop.type === "number" && prop.number !== null) {
        kpis.push({
          indicador: `${nomeLinha} · ${colName}`,
          valor: prop.number.toLocaleString("pt-PT", { minimumFractionDigits: 2 }),
          grupo: colName
        });
      } else if (prop.type === "formula" && prop.formula && prop.formula.number !== null && prop.formula.number !== undefined) {
        kpis.push({
          indicador: `${nomeLinha} · ${colName}`,
          valor: prop.formula.number.toLocaleString("pt-PT", { minimumFractionDigits: 2 }),
          grupo: colName
        });
      }
    }
  }
}
