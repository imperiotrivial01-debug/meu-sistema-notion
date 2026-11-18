export default async function handler(req, res) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID;

  if (!NOTION_TOKEN || !DATABASE_ID) {
    return res.status(500).json({ error: "Credenciais do Notion não configuradas no servidor." });
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

      for (const key in page.properties) {
        const prop = page.properties[key];
        if (prop.type === "title" && prop.title.length > 0) {
          titulo = prop.title.map(t => t.plain_text).join("");
        }
        if (prop.type === "status" && prop.status) {
          status = prop.status.name;
        } else if (prop.type === "select" && prop.select) {
          status = prop.select.name;
        }
      }

      return { id: page.id, titulo, status };
    });

    res.status(200).json({ items: itensFormatados });
  } catch (error) {
    res.status(500).json({ error: "Falha ao conectar com o Notion." });
  }
}
