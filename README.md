# Publicador josemaria.ai — MCP

MCP que conecta Claude (Cowork / Claude Desktop) con josemaria.ai para crear borradores de artículos directamente desde una conversación. Chema los revisa y publica desde el panel de administración.

## Qué hace

Expone cuatro herramientas a Claude:

- **`create_draft`** — Crea un artículo en borrador con título, contenido HTML, meta descripción, etiquetas, slug y nivel de acceso (free/premium). Nunca publica automáticamente.
- **`list_drafts`** — Lista los borradores pendientes de revisar.
- **`get_draft`** — Lee el contenido completo de un borrador por su ID.
- **`update_draft`** — Actualiza cualquier campo de un borrador existente.

## Instalación en un ordenador nuevo

### 1. Requisitos previos

Tener Node.js instalado. Si no está:

```bash
brew install node
```

Verificar:

```bash
which node
# debe devolver /opt/homebrew/bin/node
```

### 2. Clonar el repositorio

```bash
git clone https://github.com/josemagarciaruiz-cmd/publicador-josemaria-ai.git ~/Skills/publicador-josemaria-ai
```

### 3. Instalar dependencias y compilar

```bash
cd ~/Skills/publicador-josemaria-ai
npm install
npm run build
```

### 4. Configurar Claude Desktop

Ejecuta este comando en el terminal (sustituye `TU_TOKEN` por el INGEST_TOKEN de Vercel):

```bash
python3 - << 'EOF'
import json
p = "/Users/" + __import__('os').getlogin() + "/Library/Application Support/Claude/claude_desktop_config.json"
import os; os.makedirs(os.path.dirname(p), exist_ok=True)
try:
    c = json.load(open(p))
except:
    c = {}
c.setdefault("mcpServers", {})["publicador-josemaria-ai"] = {
    "command": "/opt/homebrew/bin/node",
    "args": [os.path.expanduser("~/Skills/publicador-josemaria-ai/dist/index.js")],
    "env": {
        "JOSEMARIA_URL": "https://josemaria.ai",
        "INGEST_TOKEN": "TU_TOKEN"
    }
}
json.dump(c, open(p, "w"), indent=2)
print("Listo. Reinicia Claude Desktop.")
EOF
```

El `INGEST_TOKEN` está en Vercel → josemaria-ai → Settings → Environment Variables.

### 5. Reiniciar Claude Desktop

Cierra y vuelve a abrir Claude Desktop. El MCP aparecerá junto a OpenAI y Gemini.

## Uso en Cowork

Una vez instalado, en cualquier chat de Claude puedes decir:

> *"Busca en Notion el artículo sobre X y déjamelo en borrador en la web"*

Claude leerá Notion, respetará el formato y estilo original, y llamará a `create_draft` automáticamente con título, contenido, meta descripción SEO/GEO y etiquetas.

El borrador aparece en: `https://josemaria.ai/admin/publicaciones`

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `JOSEMARIA_URL` | URL base de la web (https://josemaria.ai) |
| `INGEST_TOKEN` | Token secreto. Mismo valor que `INGEST_TOKEN` en Vercel |

## Estructura

```
publicador-josemaria-ai/
├── src/
│   └── index.ts        # Servidor MCP con las 4 tools
├── dist/               # Compilado (generado con npm run build)
├── package.json
├── tsconfig.json
└── README.md
```
