export default async function handler(req, res) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const APP_PASSWORD = process.env.APP_PASSWORD;
  const STAFF_PASSWORD = process.env.STAFF_PASSWORD;

  // 1. VERIFICAÇÃO DE AUTENTICAÇÃO E PERFIL (admin vs staff)
  let role = "admin";
  if (APP_PASSWORD || STAFF_PASSWORD) {
    const senhaRecebida = req.headers["x-app-password"] || req.body?.password;
    if (APP_PASSWORD && senhaRecebida === APP_PASSWORD) {
      role = "admin";
    } else if (STAFF_PASSWORD && senhaRecebida === STAFF_PASSWORD) {
      role = "staff";
    } else {
      return res.status(401).json({ error: "Senha incorreta ou sessão expirada." });
    }
  }

  if (req.query.auth === "1") {
    return res.status(200).json({ ok: true, role });
  }

  const tab = req.query.tab || "movimentos";

  // Bloqueia abas restritas se o utilizador tiver perfil operacional (staff)
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

  const headers = {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
  };

  const TARGET_ID = databases[tab];
  if (!TARGET_ID) {
    return res.status(400).json({ error: `ID da aba '${tab}' não configurado na Vercel.` });
  }

  // 2. LER ESTRUTURA DAS COLUNAS (?schema=1)
  if (req.method === "GET" && req.query.schema === "1") {
    try {
      const schemaRes = await fetch(`https://api.notion.com/v1/databases/${TARGET_ID}`, {
        method: "GET",
        headers
      });
      const schemaData = await schemaRes.json();

      if (!schemaRes.ok) {
        return res.status(schemaRes.status).json({ error: "Esta aba é um painel de indicadores e não aceita novos registos diretos." });
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
      const { valores } = req.body;
      const properties = await construirPropriedadesNotion(TARGET_ID, valores, headers);

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

  // 4. EDITAR REGISTO OU MARCAR COMO PAGO (PATCH)
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
          } else if (colDef.type === "checkbox" && /pag|conclu|ok/i.test(colName)) {
            properties[colName] = { checkbox: true };
            break;
          }
        }
        if (Object.keys(properties).length === 0) {
          return res.status(400).json({ error: "Não foi encontrada uma coluna de Estado com opção 'Pago/Concluído'. Use o botão Editar." });
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

  // 6. EXTRAIR INDICADORES PARA SAÚDE FINANCEIRA
  if (tab === "saude") {
    try {
      const kpis = [];
      const dbTest = await fetch(`https://api.notion.com/v1/databases/${TARGET_ID}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({})
      });

      if (dbTest.ok) {
        const dbData = await dbTest.json();
        extrairNumerosDePaginas(dbData.results, kpis);
      } else {
        const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${TARGET_ID}/children`, {
          method: "GET",
          headers
        });
        const blocksData = await blocksRes.json();

        for (const block of (blocksData.results || [])) {
          if (block.type === "child_database") {
            const subDbRes = await fetch(`https://api.notion.com/v1/databases/${block.id}/query`, {
              method: "POST",
              headers,
              body: JSON.stringify({})
            });
            if (subDbRes.ok) {
              const subDbData = await subDbRes.json();
              extrairNumerosDePaginas(subDbData.results, kpis, block.child_database?.title);
            }
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

      return res.status(200).json({ mode: "kpis", kpis, role });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao ler métricas de Saúde Financeira." });
    }
  }

  // 7. LISTAR REGISTOS COMPLETOS (COM VALORES BRUTOS PARA EDIÇÃO E GRÁFICOS)
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${TARGET_ID}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || "Erro na API do Notion" });
    }

    const itensFormatados = data.results.map(page => {
      let titulo = "Sem título";
      let status = "";
      let categoria = "";
      let dataIso = "";
      let valorNumerico = 0;
      let tipoFluxo = ""; // "entrada" ou "saida"
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
          if (/tipo|fluxo|natureza|movimento/i.test(nomeColuna)) {
            if (/entrada|receita|crédito|credito|ganho/i.test(valSel)) tipoFluxo = "entrada";
            if (/saída|saida|despesa|débito|debito|custo|gasto/i.test(valSel)) tipoFluxo = "saida";
          }
          if (/cat|grupo|centro/i.test(nomeColuna)) {
            categoria = valSel;
          } else if (!status) {
            status = valSel;
          }
          colunas.push({ nome: nomeColuna, valor: valSel, rawNum: null });
        } else if (prop.type === "number" && prop.number !== null) {
          raw[nomeColuna] = prop.number;
          if (valorNumerico === 0 || /valor|montante|total|salário|salario|líquido|liquido|realizado/i.test(nomeColuna)) {
            valorNumerico = prop.number;
          }
          colunas.push({
            nome: nomeColuna,
            valor: prop.number.toLocaleString("pt-PT", { minimumFractionDigits: 2 }),
            rawNum: prop.number
          });
        } else if (prop.type === "date" && prop.date) {
          dataIso = prop.date.start;
          raw[nomeColuna] = prop.date.start;
          colunas.push({ nome: nomeColuna, valor: prop.date.start, rawNum: null });
        } else if (prop.type === "rich_text" && prop.rich_text.length > 0) {
          const txt = prop.rich_text.map(t => t.plain_text).join("");
          raw[nomeColuna] = txt;
          colunas.push({ nome: nomeColuna, valor: txt, rawNum: null });
        } else if (prop.type === "checkbox") {
          raw[nomeColuna] = prop.checkbox;
          colunas.push({ nome: nomeColuna, valor: prop.checkbox ? "Sim" : "Não", rawNum: null });
        } else if (prop.type === "formula" && prop.formula) {
          const f = prop.formula;
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
        tipoFluxo = valorNumerico < 0 ? "saida" : "entrada";
      }

      return {
        id: page.id,
        titulo,
        status,
        categoria: categoria || status || "Geral",
        dataIso,
        valorNumerico,
        tipoFluxo,
        colunas,
        raw
      };
    });

    res.status(200).json({ mode: "list", items: itensFormatados, role });
  } catch (error) {
    res.status(500).json({ error: "Falha ao conectar com o Notion." });
  }
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
