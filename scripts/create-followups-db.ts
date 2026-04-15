/**
 * One-off: create the Followups Notion DB at the existing parent page.
 * Used to bootstrap Jeremy's prod setup; setup.ts handles this for forkers.
 */
const PARENT_PAGE_ID = "2f1ec004-5028-81b1-9805-d8167647cfc8";

const properties = {
  Name: { title: {} },
  Status: {
    select: {
      options: [
        { name: "Inbox", color: "yellow" },
        { name: "Triaged", color: "blue" },
        { name: "Doing", color: "purple" },
        { name: "Waiting", color: "orange" },
        { name: "Done", color: "green" },
      ],
    },
  },
  Priority: {
    select: {
      options: [
        { name: "P0", color: "red" },
        { name: "P1", color: "orange" },
        { name: "P2", color: "default" },
      ],
    },
  },
  Due: { date: {} },
  Owner: { rich_text: {} },
  Source: {
    select: {
      options: [
        { name: "Bluedot", color: "blue" },
        { name: "Manual", color: "default" },
      ],
    },
  },
  "Source Link": { url: {} },
  "Meeting Title": { rich_text: {} },
  "Video ID": { rich_text: {} },
};

async function main() {
  const token = process.env.NOTION_INTEGRATION_KEY;
  if (!token) throw new Error("NOTION_INTEGRATION_KEY not set");

  const create = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: PARENT_PAGE_ID },
      title: [{ type: "text", text: { content: "Followups" } }],
    }),
  });
  if (!create.ok) {
    console.error(`Notion create failed (${create.status}):`, await create.text());
    process.exit(1);
  }
  const dbResp: { id: string; data_sources: Array<{ id: string }> } = await create.json();
  console.log("Database created:", dbResp.id);
  console.log("Data source:", dbResp.data_sources[0].id);

  const update = await fetch(
    `https://api.notion.com/v1/data_sources/${dbResp.data_sources[0].id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    },
  );
  if (!update.ok) {
    console.error(`Notion update failed (${update.status}):`, await update.text());
    process.exit(1);
  }
  console.log("Properties applied.");
  console.log(`\nNOTION_FOLLOWUPS_DATA_SOURCE_ID = "${dbResp.data_sources[0].id}"`);
  console.log(`Notion URL: https://www.notion.so/${dbResp.id.replace(/-/g, "")}`);
}

main().catch(console.error);
