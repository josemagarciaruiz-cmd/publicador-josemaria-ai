#!/usr/bin/env node
/**
 * MCP — Publicador josemaria.ai
 *
 * Tools disponibles:
 *   create_draft   — Crea un artículo en borrador
 *   list_drafts    — Lista los borradores existentes
 *   get_draft      — Lee un borrador concreto
 *   update_draft   — Actualiza título, excerpt, tags, etc. de un borrador
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

// ── Arranque ───────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
