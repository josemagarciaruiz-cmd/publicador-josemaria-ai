#!/usr/bin/env node
/**
 * MCP — Publicador josemaria.ai
 *
 * Tools disponibles:
 *   create_draft          — Crea un artículo en borrador
 *   list_drafts           — Lista los borradores existentes
 *   get_draft             — Lee un borrador concreto
 *   update_draft          — Actualiza título, excerpt, tags, etc. de un borrador
 *   upload_image          — Sube una imagen local a Cloudinary y devuelve la URL
 *   list_campaigns        — Lista campañas de email con filtro de estado y métricas básicas
 *   get_campaign_metrics  — Métricas detalladas de una campaña (enviados, fallidos, fecha)
 *   send_campaign         — Envía una campaña al segmento configurado (irreversible)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Configuración ──────────────────────────────────────────────────────────
const BASE_URL = (process.env.JOSEMARIA_URL ?? "https://josemaria.ai").replace(
  /\/$/,
  ""
);
const TOKEN = process.env.INGEST_TOKEN ?? "";
const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";
const NOTION_ROOT_PAGE_ID = (process.env.NOTION_ROOT_PAGE_ID ?? "").replace(/-/g, "");
const NOTION_PRODUCTION_DB_ID = process.env.NOTION_PRODUCTION_DB_ID ?? "";
const NOTION_RADAR_DB_ID = process.env.NOTION_RADAR_DB_ID ?? "";
const CLD_CLOUD = process.env.CLOUDINARY_CLOUD_NAME ?? "";
const CLD_KEY   = process.env.CLOUDINARY_API_KEY ?? "";
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET ?? "";

if (!TOKEN) {
  process.stderr.write(
    "[publicador-josemaria-ai] AVISO: INGEST_TOKEN no configurado\n"
  );
}

// ── Cliente HTTP mínimo ────────────────────────────────────────────────────
async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data as T;
}

type NotionRichText = Array<{
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
}>;

type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: any;
};

function normalizeNotionId(value: string): string {
  const clean = value.trim().replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) {
    throw new Error("ID de Notion inválido.");
  }
  return clean.replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    "$1-$2-$3-$4-$5"
  );
}

function extractNotionId(input: string): string {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F-]{32,36}$/.test(trimmed)) {
    return normalizeNotionId(trimmed);
  }
  const match = trimmed.match(/([0-9a-fA-F]{32})(?:\?|$)/) || trimmed.match(/([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})/);
  if (!match) throw new Error("No pude extraer un page/database id válido desde Notion.");
  return normalizeNotionId(match[1]);
}

function notionPlainText(richText: NotionRichText = []): string {
  return richText.map((item) => item.plain_text ?? "").join("");
}

function notionToHtmlInline(richText: NotionRichText = []): string {
  const escapeHtml = (value: string) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return richText.map((item) => {
    let text = escapeHtml(item.plain_text ?? "");
    if (!text) return "";
    if (item.annotations?.code) text = `<code>${text}</code>`;
    if (item.annotations?.bold) text = `<strong>${text}</strong>`;
    if (item.annotations?.italic) text = `<em>${text}</em>`;
    if (item.annotations?.underline) text = `<u>${text}</u>`;
    if (item.annotations?.strikethrough) text = `<s>${text}</s>`;
    if (item.href) text = `<a href="${item.href}">${text}</a>`;
    return text;
  }).join("");
}

async function notionApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!NOTION_TOKEN) {
    throw new Error("NOTION_TOKEN no configurado.");
  }

  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "message" in data && typeof (data as { message: unknown }).message === "string"
        ? (data as { message: string }).message
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data as T;
}

async function fetchAllBlockChildren(blockId: string): Promise<NotionBlock[]> {
  let cursor: string | undefined;
  const all: NotionBlock[] = [];

  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const data = await notionApi<{ results: NotionBlock[]; next_cursor: string | null; has_more: boolean }>(
      `/blocks/${blockId}/children?${qs.toString()}`,
      { method: "GET" }
    );
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
  } while (cursor);

  return all;
}

async function blocksToHtml(blocks: NotionBlock[]): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    const value = block[block.type] ?? {};
    if (block.type === "paragraph") {
      const html = notionToHtmlInline(value.rich_text);
      if (html.trim()) parts.push(`<p>${html}</p>`);
      continue;
    }
    if (block.type === "heading_1") {
      parts.push(`<h2>${notionToHtmlInline(value.rich_text)}</h2>`);
      continue;
    }
    if (block.type === "heading_2") {
      parts.push(`<h2>${notionToHtmlInline(value.rich_text)}</h2>`);
      continue;
    }
    if (block.type === "heading_3") {
      parts.push(`<h3>${notionToHtmlInline(value.rich_text)}</h3>`);
      continue;
    }
    if (block.type === "bulleted_list_item") {
      parts.push(`<ul><li>${notionToHtmlInline(value.rich_text)}</li></ul>`);
      continue;
    }
    if (block.type === "numbered_list_item") {
      parts.push(`<ol><li>${notionToHtmlInline(value.rich_text)}</li></ol>`);
      continue;
    }
    if (block.type === "quote") {
      parts.push(`<blockquote>${notionToHtmlInline(value.rich_text)}</blockquote>`);
      continue;
    }
    if (block.type === "callout") {
      parts.push(`<blockquote>${notionToHtmlInline(value.rich_text)}</blockquote>`);
      continue;
    }
    if (block.type === "divider") {
      parts.push("<hr>");
      continue;
    }
    if (block.type === "code") {
      parts.push(`<pre><code>${notionToHtmlInline(value.rich_text)}</code></pre>`);
      continue;
    }
    if (block.type === "to_do") {
      const checked = value.checked ? "x" : " ";
      parts.push(`<p>[${checked}] ${notionToHtmlInline(value.rich_text)}</p>`);
      continue;
    }
    if (block.has_children) {
      const children = await fetchAllBlockChildren(block.id);
      const nested = await blocksToHtml(children);
      if (nested.trim()) parts.push(nested);
    }
  }
  return parts.join("\n");
}

function notionPropertyValue(property: any): string {
  if (!property) return "—";
  switch (property.type) {
    case "title":
      return notionPlainText(property.title);
    case "rich_text":
      return notionPlainText(property.rich_text);
    case "select":
      return property.select?.name ?? "—";
    case "status":
      return property.status?.name ?? "—";
    case "date":
      return property.date?.start ?? "—";
    case "url":
      return property.url ?? "—";
    case "created_time":
      return property.created_time ?? "—";
    default:
      return "—";
  }
}

async function queryNotionDatabase(databaseId: string, limit: number): Promise<Array<{ id: string; url: string; properties: Record<string, any> }>> {
  const data = await notionApi<{ results: Array<{ id: string; url: string; properties: Record<string, any> }> }>(
    `/databases/${databaseId}/query`,
    { method: "POST", body: JSON.stringify({ page_size: limit }) }
  );
  return data.results;
}

async function createNotionPage(databaseId: string, properties: Record<string, any>, children: any[] = []): Promise<any> {
  return notionApi(`/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children,
    }),
  });
}

async function updateNotionPage(pageId: string, properties: Record<string, any>): Promise<any> {
  return notionApi(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

// ── Servidor MCP ───────────────────────────────────────────────────────────
const server = new McpServer({
  name: "publicador-josemaria-ai",
  version: "1.0.0",
});

// ── TOOL: create_draft ─────────────────────────────────────────────────────
server.tool(
  "create_draft",
  "Crea un artículo en BORRADOR en josemaria.ai. Nunca se publica automáticamente; Chema lo revisa y aprueba desde el panel.",
  {
    title: z.string().min(1).describe("Título del artículo"),
    content: z
      .string()
      .min(1)
      .describe(
        "Contenido principal en HTML. Usa <h2>, <p>, <strong>, <em>, <ul>, <ol>, <li>, <blockquote>."
      ),
    excerpt: z
      .string()
      .max(160)
      .optional()
      .describe(
        "Meta descripción breve (máx. 160 caracteres). Se usa como resumen en la tarjeta y en el email."
      ),
    slug: z
      .string()
      .optional()
      .describe(
        "URL amigable. Si se omite se genera automáticamente desde el título."
      ),
    access_level: z
      .enum(["free", "premium"])
      .default("free")
      .describe("'free' = visible para todos. 'premium' = solo suscriptores."),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Etiquetas. Ej: ['derecho laboral', 'despido', 'LO 1/2025']"
      ),
    cover_image_url: z
      .string()
      .url()
      .optional()
      .describe("URL de la imagen de portada (opcional)."),
  },
  async ({ title, content, excerpt, slug, access_level, tags, cover_image_url }) => {
    try {
      const result = await api<{
        ok: boolean;
        id: string;
        slug: string;
        url: string;
        note?: string;
      }>("/api/admin/posts/ingest", {
        method: "POST",
        body: JSON.stringify({
          title,
          content,
          excerpt,
          slug,
          access_level,
          tags,
          cover_image_url,
        }),
      });

      const lines = [
        `✅ Borrador creado correctamente.`,
        ``,
        `📝 Título: ${title}`,
        `🔗 URL del panel: ${result.url}`,
        `🏷️  Slug: ${result.slug}`,
        `🔒 Acceso: ${access_level}`,
      ];
      if (tags?.length) lines.push(`🏷️  Etiquetas: ${tags.join(", ")}`);
      if (result.note) lines.push(`ℹ️  ${result.note}`);
      lines.push(``);
      lines.push(
        `Entra en el panel para revisarlo y publicarlo cuando quieras.`
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error al crear el borrador: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── TOOL: list_drafts ──────────────────────────────────────────────────────
server.tool(
  "list_drafts",
  "Lista los últimos borradores de josemaria.ai pendientes de revisar.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Número máximo de borradores a devolver (máx. 20)."),
  },
  async ({ limit }) => {
    try {
      const result = await api<{
        drafts: Array<{
          id: string;
          title: string;
          slug: string;
          excerpt: string | null;
          access_level: string;
          tags: string[];
          created_at: string;
        }>;
      }>(`/api/admin/posts/ingest?limit=${limit}`, { method: "GET" });

      if (!result.drafts?.length) {
        return {
          content: [{ type: "text", text: "No hay borradores pendientes." }],
        };
      }

      const site = BASE_URL;
      const lines = [`📋 Borradores pendientes (${result.drafts.length}):`, ``];
      result.drafts.forEach((d, i) => {
        const date = new Date(d.created_at).toLocaleDateString("es-ES");
        lines.push(`${i + 1}. **${d.title}**`);
        lines.push(`   ID: ${d.id}`);
        lines.push(`   Panel: ${site}/admin/publicaciones/${d.id}`);
        lines.push(`   Acceso: ${d.access_level} | Fecha: ${date}`);
        if (d.tags?.length) lines.push(`   Etiquetas: ${d.tags.join(", ")}`);
        lines.push(``);
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── TOOL: get_draft ────────────────────────────────────────────────────────
server.tool(
  "get_draft",
  "Obtiene el contenido completo de un borrador concreto por su ID.",
  {
    id: z.string().uuid().describe("ID del artículo (UUID)."),
  },
  async ({ id }) => {
    try {
      const result = await api<{
        post: {
          id: string;
          title: string;
          slug: string;
          excerpt: string | null;
          access_level: string;
          tags: string[];
          created_at: string;
          cover_image_url: string | null;
        };
        blocks: Array<{ block_type: string; content: string }>;
      }>(`/api/admin/posts/ingest/${id}`, { method: "GET" });

      const { post, blocks } = result;
      const lines = [
        `📄 **${post.title}**`,
        `ID: ${post.id}`,
        `Slug: ${post.slug}`,
        `Acceso: ${post.access_level}`,
        `Etiquetas: ${post.tags?.join(", ") || "—"}`,
        `Excerpt: ${post.excerpt || "—"}`,
        ``,
        `── Contenido ──`,
      ];
      blocks.forEach((b) => {
        lines.push(`[${b.block_type.toUpperCase()}]`);
        lines.push(b.content);
        lines.push(``);
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── TOOL: update_draft ─────────────────────────────────────────────────────
server.tool(
  "update_draft",
  "Actualiza los metadatos o el contenido de un borrador existente. Solo funciona con artículos en estado 'draft'.",
  {
    id: z.string().uuid().describe("ID del artículo a actualizar."),
    title: z.string().optional().describe("Nuevo título."),
    content: z.string().optional().describe("Nuevo contenido HTML principal."),
    excerpt: z.string().max(160).optional().describe("Nueva meta descripción."),
    slug: z.string().optional().describe("Nuevo slug."),
    access_level: z.enum(["free", "premium"]).optional(),
    tags: z.array(z.string()).optional(),
    cover_image_url: z.string().url().optional(),
  },
  async ({ id, title, content, excerpt, slug, access_level, tags, cover_image_url }) => {
    try {
      const result = await api<{ ok: boolean; url: string }>(
        `/api/admin/posts/ingest/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            title,
            content,
            excerpt,
            slug,
            access_level,
            tags,
            cover_image_url,
          }),
        }
      );

      return {
        content: [
          {
            type: "text",
            text: `✅ Borrador actualizado.\n\nPanel: ${result.url}`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error al actualizar: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── TOOL: upload_image ─────────────────────────────────────────────────────
server.tool(
  "upload_image",
  "Sube una imagen a Cloudinary y devuelve la URL pública permanente lista para usar en cover_image_url o dentro del HTML de un artículo.",
  {
    file_path: z
      .string()
      .describe(
        "Ruta absoluta del fichero de imagen en el sistema local. Ej: /Users/josemariagarciaruiz/Downloads/portada.jpg"
      ),
    folder: z
      .string()
      .optional()
      .default("josemaria-ai")
      .describe("Carpeta de Cloudinary donde se guardará. Por defecto 'josemaria-ai'."),
    public_id: z
      .string()
      .optional()
      .describe("Nombre identificador en Cloudinary. Si se omite lo genera automáticamente."),
  },
  async ({ file_path, folder, public_id }) => {
    try {
      if (!CLD_CLOUD || !CLD_KEY || !CLD_SECRET) {
        throw new Error(
          "Credenciales de Cloudinary no configuradas (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)."
        );
      }

      // Leer el fichero como base64
      const { readFileSync } = await import("fs");
      const fileBuffer = readFileSync(file_path);
      const base64 = fileBuffer.toString("base64");
      const ext = file_path.split(".").pop()?.toLowerCase() ?? "jpg";
      const mimeTypes: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg",
        png: "image/png", gif: "image/gif",
        webp: "image/webp", svg: "image/svg+xml",
      };
      const mime = mimeTypes[ext] ?? "image/jpeg";
      const dataUri = `data:${mime};base64,${base64}`;

      // Firma para upload autenticado
      const { createHash } = await import("crypto");
      const timestamp = Math.floor(Date.now() / 1000);
      const paramParts: string[] = [`timestamp=${timestamp}`];
      if (folder) paramParts.push(`folder=${folder}`);
      if (public_id) paramParts.push(`public_id=${public_id}`);
      paramParts.sort();
      const signatureBase = paramParts.join("&") + CLD_SECRET;
      const signature = createHash("sha256").update(signatureBase).digest("hex");

      // Construir FormData
      const formData = new FormData();
      formData.append("file", dataUri);
      formData.append("api_key", CLD_KEY);
      formData.append("timestamp", String(timestamp));
      formData.append("signature", signature);
      if (folder) formData.append("folder", folder);
      if (public_id) formData.append("public_id", public_id);

      const res = await fetch(
        `https://api.cloudinary.com/v1_1/${CLD_CLOUD}/image/upload`,
        { method: "POST", body: formData }
      );

      const data = await res.json() as {
        secure_url?: string;
        public_id?: string;
        error?: { message: string };
      };

      if (!res.ok || data.error) {
        throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      }

      const url = data.secure_url!;
      return {
        content: [
          {
            type: "text",
            text: [
              `✅ Imagen subida correctamente.`,
              ``,
              `🔗 URL: ${url}`,
              `📁 Public ID: ${data.public_id}`,
              ``,
              `Puedes usar esta URL como cover_image_url en create_draft o update_draft,`,
              `o pegarla dentro del contenido HTML con <img src="${url}" alt="...">.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error al subir imagen: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── TOOLS: Notion ──────────────────────────────────────────────────────────
server.tool(
  "list_notion_items",
  "Lista piezas dentro de la base editorial de Notion conectada al MCP.",
  {
    database_id_or_url: z
      .string()
      .optional()
      .describe("ID o URL de la base de datos de Notion. Si se omite, usa la base hija encontrada bajo NOTION_ROOT_PAGE_ID."),
    limit: z.number().int().min(1).max(20).default(10),
  },
  async ({ database_id_or_url, limit }) => {
    try {
      let databaseId = database_id_or_url ? extractNotionId(database_id_or_url) : "";

      if (!databaseId) {
        if (!NOTION_ROOT_PAGE_ID) throw new Error("Falta NOTION_ROOT_PAGE_ID y no se indicó database_id_or_url.");
        const children = await fetchAllBlockChildren(normalizeNotionId(NOTION_ROOT_PAGE_ID));
        const dbBlock = children.find((b) => b.type === "child_database");
        if (!dbBlock) throw new Error("No encontré ninguna base de datos hija bajo la página raíz configurada.");
        databaseId = dbBlock.id;
      }

      const db = await notionApi<{ title?: NotionRichText }>(`/databases/${databaseId}`, { method: "GET" });
      const rows = await queryNotionDatabase(databaseId, limit);

      const lines = [`🗂️ Notion — ${notionPlainText(db.title) || "Base editorial"}`, ""];
      for (const [i, page] of rows.entries()) {
        const p = page.properties;
        lines.push(`${i + 1}. ${notionPropertyValue(p["Título"] ?? p["Name"] ?? p["title"])}`);
        lines.push(`   ID: ${page.id}`);
        lines.push(`   Estado: ${notionPropertyValue(p["Estado"])}`);
        lines.push(`   Formato: ${notionPropertyValue(p["Formato"])}`);
        lines.push(`   Clasificación: ${notionPropertyValue(p["Clasificación"])}`);
        lines.push(`   URL: ${page.url}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error leyendo Notion: ${msg}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_notion_page",
  "Lee una pieza concreta de Notion y devuelve metadatos + extracto + HTML generado desde sus bloques.",
  {
    page_id_or_url: z.string().describe("ID o URL de la página de Notion."),
  },
  async ({ page_id_or_url }) => {
    try {
      const pageId = extractNotionId(page_id_or_url);
      const page = await notionApi<{ id: string; url: string; properties: Record<string, any> }>(`/pages/${pageId}`, { method: "GET" });
      const blocks = await fetchAllBlockChildren(pageId);
      const html = await blocksToHtml(blocks);
      const title = notionPropertyValue(page.properties["Título"] ?? page.properties["Name"] ?? page.properties["title"]);
      const lines = [
        `📄 ${title}`,
        `ID: ${page.id}`,
        `Estado: ${notionPropertyValue(page.properties["Estado"])}`,
        `Formato: ${notionPropertyValue(page.properties["Formato"])}`,
        `Clasificación: ${notionPropertyValue(page.properties["Clasificación"])}`,
        `Etiquetas: ${notionPropertyValue(page.properties["Etiquetas"])}`,
        `URL: ${page.url}`,
        "",
        "── HTML generado ──",
        html || "(sin bloques convertibles)",
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error leyendo la página de Notion: ${msg}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "create_draft_from_notion",
  "Convierte una página de Notion en borrador de josemaria.ai usando sus metadatos editoriales y el cuerpo convertido a HTML.",
  {
    page_id_or_url: z.string().describe("ID o URL de la página de Notion."),
    slug: z.string().optional().describe("Slug manual si quieres forzarlo."),
    excerpt: z.string().max(160).optional().describe("Excerpt manual si quieres sobrescribirlo."),
    access_level: z.enum(["free", "premium"]).optional().describe("Sobrescribe el acceso si no quieres inferirlo desde Clasificación."),
    update_notion_status: z.boolean().default(true).describe("Si es true, actualiza el estado de la pieza en Notion tras crear el borrador."),
  },
  async ({ page_id_or_url, slug, excerpt, access_level, update_notion_status }) => {
    try {
      const pageId = extractNotionId(page_id_or_url);
      const page = await notionApi<{ id: string; url: string; properties: Record<string, any> }>(`/pages/${pageId}`, { method: "GET" });
      const blocks = await fetchAllBlockChildren(pageId);
      const content = await blocksToHtml(blocks);
      const title = notionPropertyValue(page.properties["Título"] ?? page.properties["Name"] ?? page.properties["title"]);
      const tagsRaw = notionPropertyValue(page.properties["Etiquetas"]);
      const tags = tagsRaw === "—" ? undefined : tagsRaw.split(",").map((tag) => tag.trim()).filter(Boolean);
      const classification = notionPropertyValue(page.properties["Clasificación"]);
      const inferredAccess = classification.toLowerCase().includes("premium") ? "premium" : "free";
      const generatedExcerpt = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      const finalExcerpt = excerpt ?? (generatedExcerpt || undefined);

      const result = await api<{ url: string; slug: string }>("/api/admin/posts/ingest", {
        method: "POST",
        body: JSON.stringify({
          title,
          content,
          excerpt: finalExcerpt,
          slug,
          access_level: access_level ?? inferredAccess,
          tags,
        }),
      });

      if (update_notion_status) {
        const properties: Record<string, any> = {
          "Estado": { status: { name: "Listo para publicar" } },
        };
        if (page.properties["URL publicada"]) {
          properties["URL publicada"] = { url: result.url };
        }
        await updateNotionPage(pageId, properties);
      }

      return {
        content: [{
          type: "text",
          text: [
            `✅ Borrador creado desde Notion.`,
            ``,
            `📝 Título: ${title}`,
            `🔗 Notion: ${page.url}`,
            `🔗 Panel: ${result.url}`,
            `🏷️ Slug: ${result.slug}`,
            `🔒 Acceso: ${access_level ?? inferredAccess}`,
            update_notion_status ? `🗂️ Estado Notion: Listo para publicar` : `🗂️ Estado Notion: sin cambios`,
          ].join("\n"),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error creando borrador desde Notion: ${msg}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_notion_radar",
  "Lista entradas del radar jurídico y de fuentes en Notion.",
  {
    limit: z.number().int().min(1).max(20).default(10),
  },
  async ({ limit }) => {
    try {
      if (!NOTION_RADAR_DB_ID) throw new Error("NOTION_RADAR_DB_ID no configurado.");
      const db = await notionApi<{ title?: NotionRichText }>(`/databases/${NOTION_RADAR_DB_ID}`, { method: "GET" });
      const rows = await queryNotionDatabase(NOTION_RADAR_DB_ID, limit);
      const lines = [`🧭 Radar — ${notionPlainText(db.title) || "Radar jurídico"}`, ""];
      for (const [i, page] of rows.entries()) {
        const p = page.properties;
        lines.push(`${i + 1}. ${notionPropertyValue(p["Título"] ?? p["Name"] ?? p["title"])}`);
        lines.push(`   ID: ${page.id}`);
        lines.push(`   Tipo: ${notionPropertyValue(p["Tipo"])}`);
        lines.push(`   Estado: ${notionPropertyValue(p["Estado"])}`);
        lines.push(`   Impacto: ${notionPropertyValue(p["Impacto"])}`);
        lines.push(`   Fuente: ${notionPropertyValue(p["Fuente oficial"])}`);
        lines.push("");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error leyendo el radar: ${msg}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "create_production_item_from_radar",
  "Crea una nueva pieza en Producción editorial a partir de una entrada del radar jurídico de Notion.",
  {
    radar_page_id_or_url: z.string().describe("ID o URL de la entrada del radar."),
    formato: z.enum(["Blog", "LinkedIn", "YouTube", "Email", "Premium"]).default("Blog"),
    canal: z.enum(["josemaria.ai", "LinkedIn", "YouTube", "Email", "Comunidad"]).default("josemaria.ai"),
    clasificacion: z.enum(["Libre", "Premium 15€", "Premium Plus 30€"]).default("Libre"),
    prioridad: z.enum(["Alta", "Media", "Baja"]).default("Media"),
    update_radar_status: z.boolean().default(true).describe("Si es true, marca la entrada del radar como aprovechada tras crear la pieza."),
  },
  async ({ radar_page_id_or_url, formato, canal, clasificacion, prioridad, update_radar_status }) => {
    try {
      if (!NOTION_PRODUCTION_DB_ID) throw new Error("NOTION_PRODUCTION_DB_ID no configurado.");
      const radarId = extractNotionId(radar_page_id_or_url);
      const radarPage = await notionApi<{ id: string; url: string; properties: Record<string, any> }>(`/pages/${radarId}`, { method: "GET" });
      const radarBlocks = await fetchAllBlockChildren(radarId);
      const title = notionPropertyValue(radarPage.properties["Título"] ?? radarPage.properties["Name"] ?? radarPage.properties["title"]);
      const notes = notionPropertyValue(radarPage.properties["Notas"]);
      const sourceUrl = notionPropertyValue(radarPage.properties["Fuente oficial"]);
      const impact = notionPropertyValue(radarPage.properties["Impacto"]);
      const type = notionPropertyValue(radarPage.properties["Tipo"]);
      const dateKey = notionPropertyValue(radarPage.properties["Fecha clave"]);

      const children = radarBlocks.length ? radarBlocks.map((block) => ({
        object: "block",
        type: block.type,
        [block.type]: block[block.type],
      })) : [];

      const productionProperties: Record<string, any> = {
        "Título": { title: [{ text: { content: title } }] },
        "Estado": { status: { name: "Idea" } },
        "Formato": { select: { name: formato } },
        "Canal": { select: { name: canal } },
        "Clasificación": { select: { name: clasificacion } },
        "Prioridad": { select: { name: prioridad } },
        "Notas operativas": {
          rich_text: [{ text: { content: [
            type !== "—" ? `Tipo: ${type}` : "",
            impact !== "—" ? `Impacto: ${impact}` : "",
            dateKey !== "—" ? `Fecha clave: ${dateKey}` : "",
            notes !== "—" ? `Notas radar: ${notes}` : "",
          ].filter(Boolean).join(" | ") } }],
        },
      };
      if (sourceUrl !== "—") productionProperties["Fuente base"] = { url: sourceUrl };

      const created = await createNotionPage(
        NOTION_PRODUCTION_DB_ID,
        productionProperties,
        children
      );

      if (update_radar_status) {
        await updateNotionPage(radarId, {
          "Estado": { status: { name: "Aprovechada" } },
        });
      }

      return {
        content: [{
          type: "text",
          text: [
            `✅ Pieza creada en Producción editorial desde el radar.`,
            ``,
            `📝 Título: ${title}`,
            `🧭 Radar: ${radarPage.url}`,
            `🗂️ Producción: ${created.url}`,
            `Formato: ${formato} | Canal: ${canal} | Clasificación: ${clasificacion}`,
            update_radar_status ? `🧭 Estado radar: Aprovechada` : `🧭 Estado radar: sin cambios`,
          ].join("\n"),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error creando pieza desde el radar: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── list_campaigns ────────────────────────────────────────────────────────
server.tool(
  "list_campaigns",
  "Lista las campañas de email marketing (borradores y enviadas) con métricas básicas.",
  {
    status: z
      .enum(["all", "draft", "ready", "sent"])
      .optional()
      .describe("Filtrar por estado. Por defecto muestra todas."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Máximo de resultados (por defecto 20)."),
  },
  async ({ status = "all", limit = 20 }) => {
    try {
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      params.set("limit", String(limit));

      const data = await api<unknown[]>(
        `/api/admin/campaigns?${params.toString()}`
      );

      if (!Array.isArray(data) || data.length === 0) {
        return {
          content: [{ type: "text", text: "No hay campañas que coincidan con el filtro." }],
        };
      }

      const lines = (data as Record<string, unknown>[]).map((c) => {
        const status = c.status as string;
        const icon = status === "sent" ? "✅" : status === "ready" ? "🟡" : "📝";
        const sentInfo = status === "sent"
          ? ` | Enviados: ${c.sent_count ?? 0} | Fecha: ${c.sent_at ? new Date(c.sent_at as string).toLocaleDateString("es-ES") : "—"}`
          : "";
        return `${icon} [${(c.id as string).slice(0, 8)}] ${c.subject} (${status}, ${c.segment ?? "all"})${sentInfo}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `📧 Campañas (${data.length}):\n\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── get_campaign_metrics ──────────────────────────────────────────────────
server.tool(
  "get_campaign_metrics",
  "Obtiene las métricas detalladas de una campaña de email (enviados, fallidos, estado).",
  {
    campaign_id: z.string().uuid().describe("ID de la campaña."),
  },
  async ({ campaign_id }) => {
    try {
      const data = await api<Record<string, unknown>>(
        `/api/admin/campaigns/${campaign_id}/metrics`
      );

      const lines = [
        `📊 Métricas — ${data.subject}`,
        ``,
        `Estado:       ${data.status}`,
        `Segmento:     ${data.segment ?? "all"}`,
        `Enviados:     ${data.sent_count ?? 0}`,
        `Fallidos:     ${data.error_count ?? 0}`,
        `Fecha envío:  ${data.sent_at ? new Date(data.sent_at as string).toLocaleString("es-ES") : "—"}`,
        `Creada:       ${new Date(data.created_at as string).toLocaleDateString("es-ES")}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── send_campaign ─────────────────────────────────────────────────────────
server.tool(
  "send_campaign",
  "Envía una campaña de email al segmento configurado. Solo funciona si la campaña está en estado 'draft' o 'ready'. El envío es inmediato e irreversible.",
  {
    campaign_id: z.string().uuid().describe("ID de la campaña a enviar."),
  },
  async ({ campaign_id }) => {
    try {
      const data = await api<Record<string, unknown>>(
        `/api/admin/email/${campaign_id}/send`,
        { method: "POST" }
      );

      if (!data.ok) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Error al enviar: ${(data as Record<string, unknown>).error ?? "desconocido"}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `✅ Campaña enviada con éxito.`,
              ``,
              `Destinatarios totales: ${data.total}`,
              `Enviados correctamente: ${data.sent}`,
              `Errores: ${data.errors ?? 0}`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ── Arranque ───────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
