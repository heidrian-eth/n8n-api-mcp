# n8n API MCP Server

A Model Context Protocol (MCP) server for interacting with n8n instances. Provides comprehensive workflow management, execution monitoring, and API exploration tools.

## Features

- **22 tools** for complete n8n API interaction
- Workflow CRUD operations with local validation
- Execution and credential management
- API endpoint discovery with OpenAPI spec support
- Fast Memory cache for frequently used API calls

## Tools

### Workflow Management (7 tools)

| Tool | Description |
|------|-------------|
| `list_workflows` | List all workflows with optional filtering by active status |
| `get_workflow` | Get a workflow by ID with full nodes, connections, and settings |
| `create_workflow` | Create workflow with local JSON validation before submission |
| `update_workflow` | Update workflow (fetches existing, merges updates, saves) |
| `validate_workflow` | Validate workflow JSON structure before submission |
| `activate_workflow` | Activate/publish a workflow |
| `deactivate_workflow` | Deactivate a workflow |

### Execution Management (2 tools)

| Tool | Description |
|------|-------------|
| `list_executions` | List executions with filters (workflowId, status, limit) |
| `get_execution` | Get execution details including input/output data |

### Credential Management (2 tools)

| Tool | Description |
|------|-------------|
| `list_credentials` | List available credentials (metadata only) |
| `get_credential_schema` | Get configuration schema for a credential type |

### API Discovery (4 tools)

| Tool | Description |
|------|-------------|
| `search_api_endpoints` | Search local API spec database for endpoints |
| `get_api_endpoint_details` | Get detailed endpoint info (parameters, request body, responses) |
| `load_api_spec_from_json` | Load OpenAPI spec from a JSON file |
| `download_api_spec` | Download latest n8n OpenAPI spec from GitHub |

### Core API Tools (4 tools)

| Tool | Description |
|------|-------------|
| `execute_api_call` | Execute any API call to n8n instance |
| `send_raw_api_request` | Execute API call using raw request string |
| `natural_language_api_search` | Search for API calls using natural language |

### Fast Memory Cache (3 tools)

| Tool | Description |
|------|-------------|
| `save_to_fast_memory` | Save successful API call for quick retrieval |
| `list_fast_memory` | List cached API calls |
| `delete_from_fast_memory` | Delete a cached entry |
| `clear_fast_memory` | Clear all cached entries |

## Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/heidrian-eth/n8n-api-mcp.git
   cd n8n-api-mcp
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the server:**
   ```bash
   npm run build
   ```

## Configuration

Set these environment variables in your MCP client configuration:

| Variable | Description | Default |
|----------|-------------|---------|
| `N8N_URL` | Your n8n instance URL | `http://localhost:5678` |
| `N8N_API_KEY` | Your n8n API key | Required |

## MCP Client Configuration

### Claude Code / Cline

Add to your MCP settings:

```json
{
  "mcpServers": {
    "n8n-api-mcp": {
      "command": "node",
      "args": ["./path/to/n8n-api-mcp/build/index.js"],
      "env": {
        "N8N_URL": "https://your-instance.app.n8n.cloud",
        "N8N_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Loading the API Specification

Populate the API endpoint database for search functionality:

**Option 1: Download from GitHub (recommended)**
```
download_api_spec
```

**Option 2: Load from local file**
```
load_api_spec_from_json(json_file_path="/path/to/n8n-openapi.json")
```

## Development

```bash
# Watch mode with auto-rebuild
npm run watch

# Debug with MCP Inspector
npm run inspector
```

## License

MIT
