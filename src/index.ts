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
