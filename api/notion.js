export default async function handler(req, res) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const tab = req.query.tab || "movimentos";

  const databases = {
    movimentos: process.env.NOTION_DATABASE_ID,
    folha: process.env.NOTION_FOLHA_ID,
    orcamentos: process.env.NOTION_ORCAMENTOS_ID
  };

  const DATABASE_ID = databases[tab];

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "NOTION_TOKEN não configurado na Vercel." });
  }
  if (!DATABASE_ID) {
    return res.status(400).json({ error: `ID da tabela '${tab}' ainda não configurado nas variáveis da Vercel.` });
  }

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
      },
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

    res.status(200).json({ items: itensFormatados });
  } catch (error) {
    res.status(500).json({ error: "Falha ao conectar com o Notion." });
  }
}
