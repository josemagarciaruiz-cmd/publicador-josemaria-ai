# Publicador josemaria.ai — Guía de instalación

## Paso 1 — Generar el token secreto

Abre una terminal y ejecuta:

```bash
openssl rand -hex 32
```

Copia el resultado. Es tu `INGEST_TOKEN`. Lo necesitas en los pasos 2 y 3.

---

## Paso 2 — Añadir variables de entorno en Vercel

En el panel de Vercel de josemaria-ai, entra en **Settings → Environment Variables** y añade:

| Nombre | Valor |
|--------|-------|
| `INGEST_TOKEN` | el token que generaste en el paso 1 |

Redeploy obligatorio para que surta efecto.

---

## Paso 3 — Mover la carpeta del MCP a tu ordenador

Copia la carpeta `publicador-josemaria-ai` a un sitio permanente en tu Mac, por ejemplo:

```
~/Library/Application Support/Claude/mcps/publicador-josemaria-ai/
```

---

## Paso 4 — Configurar Claude Desktop

Abre el fichero de configuración de Claude Desktop:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Añade dentro de `mcpServers`:

```json
{
  "mcpServers": {
    "publicador-josemaria-ai": {
      "command": "node",
      "args": [
        "/Users/TU_USUARIO/Library/Application Support/Claude/mcps/publicador-josemaria-ai/dist/index.js"
      ],
      "env": {
        "JOSEMARIA_URL": "https://josemaria.ai",
        "INGEST_TOKEN": "pega-aqui-tu-token"
      }
    }
  }
}
```

Sustituye `TU_USUARIO` por tu nombre de usuario de macOS y el token por el del paso 1.

---

## Paso 5 — Reiniciar Claude Desktop

Cierra y vuelve a abrir Claude Desktop. En el icono del martillo (🔨) de cualquier chat deberías ver las herramientas:

- `create_draft`
- `list_drafts`
- `get_draft`
- `update_draft`

---

## Uso en un Proyecto de Claude

Para no cargar tokens innecesarios, crea un **Proyecto** en Claude llamado "Blog josemaria.ai" y activa **solo** este MCP. Pon en las instrucciones del proyecto algo como:

> Eres el asistente de redacción de josemaria.ai, blog de derecho laboral español de Chema García. Cuando redactes artículos usa siempre HTML semántico (<h2>, <p>, <strong>, <ul>). El tono es profesional pero accesible. Cuando termines un artículo, usa create_draft para enviarlo a borrador. Nunca lo publiques directamente.

---

## Flujo de trabajo habitual

1. Dile a Claude: *"Escríbeme un artículo sobre el nuevo régimen de despido objetivo tras la LO 1/2025, acceso premium, etiquetas: despido, LO 1/2025, procedimiento"*
2. Claude redacta y llama a `create_draft` automáticamente
3. Recibes el enlace directo al panel: `https://josemaria.ai/admin/publicaciones/:id`
4. Entras, revisas, retocar si hace falta, y pulsas **Publicar**
