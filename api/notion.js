export default async function handler(req, res) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const APP_PASSWORD = process.env.APP_PASSWORD;

  // 1. VERIFICAÇÃO DE AUTENTICAÇÃO
  if (APP_PASSWORD) {
    const senhaRecebida = req.headers["x-app-password"] || req.body?.password;
    if (senhaRecebida !== APP_PASSWORD) {
      return res.status(401).json({ error: "Senha incorreta ou sessão expirada." });
    }
    // Se for apenas um pedido de validação de login (?auth=1)
    if (req.query.auth === "1") {
      return res.status(200).json({ ok: true });
    }
  } else if (req.query.auth === "1") {
    return res.status(200).json({ ok: true });
  }

  const tab = req.query.tab || "movimentos";
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

  // 2. LER ESTRUTURA DAS COLUNAS PARA MONTAR O FORMULÁRIO DINÂMICO (?schema=1)
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

  // 3. GRAVAR NOVO REGISTO NA ABA ATIVA (POST)
  if (req.method === "POST") {
    try {
      const { valores } = req.body;
      const schemaRes = await fetch(`https://api.notion.com/v1/databases/${TARGET_ID}`, {
        method: "GET",
        headers
      });
      const schemaData = await schemaRes.json();

      if (!schemaRes.ok) {
        return res.status(schemaRes.status).json({ error: schemaData.message || "Erro ao validar tabela." });
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
      return res.status(500).json({ error: "Falha interna ao criar registo." });
    }
  }

  // 4. EXTRAIR INDICADORES NUMÉRICOS PARA A ABA SAÚDE FINANCEIRA
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

      return res.status(200).json({ mode: "kpis", kpis });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao ler métricas de Saúde Financeira." });
    }
  }

  // 5. LISTAR REGISTOS NORMAIS DAS TABELAS
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
      const colunas = [];

      for (const [nomeColuna, prop] of Object.entries(page.properties)) {
        if (prop.type === "title") {
          titulo = prop.title.map(t => t.plain_text).join("") || "Sem título";
        } else if (prop.type === "status" && prop.status) {
          status = prop.status.name;
        } else if (prop.type === "select" && prop.select) {
          status = prop.select.name;
        } else if (prop.type === "number" && prop.number !== null) {
          colunas.push({ nome: nomeColuna, valor: prop.number.toLocaleString("pt-PT", { minimumFractionDigits: 2 }) });
        } else if (prop.type === "date" && prop.date) {
          colunas.push({ nome: nomeColuna, valor: prop.date.start });
        } else if (prop.type === "rich_text" && prop.rich_text.length > 0) {
          colunas.push({ nome: nomeColuna, valor: prop.rich_text.map(t => t.plain_text).join("") });
        } else if (prop.type === "checkbox") {
          colunas.push({ nome: nomeColuna, valor: prop.checkbox ? "Sim" : "Não" });
        } else if (prop.type === "formula" && prop.formula) {
          const f = prop.formula;
          const val = f.number !== undefined && f.number !== null
            ? f.number.toLocaleString("pt-PT", { minimumFractionDigits: 2 })
            : (f.string || (f.boolean !== undefined ? (f.boolean ? "Sim" : "Não") : ""));
          if (val !== "") colunas.push({ nome: nomeColuna, valor: val });
        } else if (prop.type === "multi_select" && prop.multi_select.length > 0) {
          colunas.push({ nome: nomeColuna, valor: prop.multi_select.map(s => s.name).join(", ") });
        }
      }

      return { id: page.id, titulo, status, colunas };
    });

    res.status(200).json({ mode: "list", items: itensFormatados });
  } catch (error) {
    res.status(500).json({ error: "Falha ao conectar com o Notion." });
  }
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
