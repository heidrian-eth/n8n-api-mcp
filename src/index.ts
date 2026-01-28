#!/usr/bin/env node

/**
 * MCP Server for interacting with an n8n instance.
 * Provides tools for:
 * - Searching API endpoints and executing calls
 * - Managing 'fast memory' cache for natural language queries
 * - Creating, updating, and validating workflows
 * - Managing executions and credentials
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from 'axios';
import sqlite3 from 'sqlite3';
import fs from 'fs/promises';
import { setupDatabases, closeDatabases } from './db/initDb.js';
import { workflowToolDefinitions, handleWorkflowTool } from './tools/workflow.js';
import { executionToolDefinitions, handleExecutionTool } from './tools/execution.js';
import { credentialToolDefinitions, handleCredentialTool } from './tools/credential.js';

// --- Interfaces ---
interface OpenApiPathItem {
    summary?: string;
    description?: string;
    parameters?: unknown[];
    requestBody?: unknown;
    responses?: unknown;
    tags?: string[];
    [method: string]: unknown;
}

interface OpenApiSpec {
    openapi: string;
    info: { title: string; version: string; };
    paths: { [path: string]: OpenApiPathItem };
}

interface FastMemoryEntry {
    id: number;
    natural_language_query: string;
    api_path: string;
    api_method: string;
    api_params?: string;
    api_data?: string;
    description?: string;
    created_at: string;
}

// --- Configuration ---
const N8N_URL = process.env.N8N_URL || 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY || 'YOUR_N8N_API_KEY';

if (N8N_API_KEY === 'YOUR_N8N_API_KEY') {
    console.warn("Warning: N8N_API_KEY environment variable not set. Using placeholder.");
}

// --- Database and API Client ---
let apiSpecDb: sqlite3.Database;
let fastMemoryDb: sqlite3.Database;
let axiosInstance: AxiosInstance;

async function initializeServer() {
    const dbs = await setupDatabases();
    apiSpecDb = dbs.apiSpecDb;
    fastMemoryDb = dbs.fastMemoryDb;

    axiosInstance = axios.create({
        baseURL: `${N8N_URL}/api/v1`,
        headers: {
            'X-N8N-API-KEY': N8N_API_KEY,
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });

    console.log(`n8n MCP Server initialized. Target URL: ${N8N_URL}`);
}

// --- MCP Server Setup ---
const server = new Server(
  {
    name: "n8n-api-mcp",
    version: "0.2.0",
    description: "MCP Server for n8n API with workflow building, execution, and credential tools.",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// --- Tool Definitions ---
const coreToolDefinitions = [
    {
        name: "search_api_endpoints",
        description: "Search available n8n API endpoints stored in the local spec database.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search term for path, summary, description, or tags." },
                limit: { type: "integer", description: "Maximum number of results", default: 10 }
            },
            required: ["query"]
        }
    },
    {
        name: "get_api_endpoint_details",
        description: "Get detailed information for a specific n8n API endpoint from the local spec database.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Exact API path (e.g., /workflows)." },
                method: { type: "string", description: "HTTP method (e.g., GET, POST)." }
            },
            required: ["path", "method"]
        }
    },
    {
        name: "execute_api_call",
        description: "Execute an API call to the configured n8n instance.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "API endpoint path (e.g., /workflows)." },
                method: { type: "string", description: "HTTP method (GET, POST, PUT, DELETE, etc.)." },
                params: { type: "object", description: "Query parameters as a JSON object.", default: {} },
                data: { type: "object", description: "Request body data as a JSON object (for POST, PUT, PATCH).", default: {} }
            },
            required: ["path", "method"]
        }
    },
    {
        name: "natural_language_api_search",
        description: "Search for n8n API calls using natural language. Checks fast memory first.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Natural language description of the desired API call." },
                max_results: { type: "integer", description: "Maximum number of results (from spec DB if fast memory fails)", default: 5 }
            },
            required: ["query"]
        }
    },
    {
        name: "save_to_fast_memory",
        description: "Save a successful natural language query and its corresponding API call details to fast memory.",
        inputSchema: {
            type: "object",
            properties: {
                natural_language_query: { type: "string", description: "The original natural language query." },
                api_path: { type: "string", description: "The executed API path." },
                api_method: { type: "string", description: "The executed API method." },
                api_params: { type: "object", description: "The executed API query parameters.", default: {} },
                api_data: { type: "object", description: "The executed API request body.", default: {} },
                description: { type: "string", description: "Optional user description for this entry." }
            },
            required: ["natural_language_query", "api_path", "api_method"]
        }
    },
    {
        name: "list_fast_memory",
        description: "List entries stored in fast memory.",
        inputSchema: {
            type: "object",
            properties: {
                search_term: { type: "string", description: "Optional term to filter entries by NL query or description." },
                limit: { type: "integer", description: "Maximum number of results", default: 20 }
            },
            required: []
        }
    },
    {
        name: "delete_from_fast_memory",
        description: "Delete an entry from fast memory by its ID.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "integer", description: "The ID of the fast memory entry to delete." }
            },
            required: ["id"]
        }
    },
    {
        name: "load_api_spec_from_json",
        description: "Load n8n API specification data from a JSON file into the api_spec.db.",
        inputSchema: {
            type: "object",
            properties: {
                json_file_path: { type: "string", description: "Absolute path to the OpenAPI/Swagger JSON file." }
            },
            required: ["json_file_path"]
        }
    },
    {
        name: "clear_fast_memory",
        description: "Clear all entries from the fast memory database.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "send_raw_api_request",
        description: "Send a raw API request string to the n8n API. Format: 'METHOD /path?query=val [JSON_BODY]'",
        inputSchema: {
            type: "object",
            properties: {
                raw_request: { type: "string", description: "Raw request string (e.g., 'GET /workflows?limit=5', 'POST /workflows {\"name\":\"New Workflow\"}')" }
            },
            required: ["raw_request"]
        }
    },
    {
        name: "download_api_spec",
        description: "Download the latest n8n OpenAPI specification from GitHub and load it into the local database. Updates the API endpoint search database.",
        inputSchema: {
            type: "object",
            properties: {},
            required: []
        }
    }
];

// Combine all tool definitions
const allToolDefinitions = [
    ...coreToolDefinitions,
    ...workflowToolDefinitions,
    ...executionToolDefinitions,
    ...credentialToolDefinitions
];

// --- Logging ---
const logger = {
    info: (message: string, ...optionalParams: unknown[]) => console.log(`[INFO] ${message}`, ...optionalParams),
    warn: (message: string, ...optionalParams: unknown[]) => console.warn(`[WARN] ${message}`, ...optionalParams),
    error: (message: string, ...optionalParams: unknown[]) => console.error(`[ERROR] ${message}`, ...optionalParams),
};

// --- Database Helper Functions ---
function dbAll(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error("DB Error (all):", err.message, "SQL:", sql, "Params:", params);
                reject(new McpError(ErrorCode.InternalError, `Database query failed: ${err.message}`));
            } else {
                resolve(rows);
            }
        });
    });
}

function dbRun(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<{ lastID: number, changes: number }> {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                console.error("DB Error (run):", err.message, "SQL:", sql, "Params:", params);
                reject(new McpError(ErrorCode.InternalError, `Database operation failed: ${err.message}`));
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
}

// --- API Call Helper ---
async function makeN8nApiRequest(
    method: string,
    path: string,
    params: Record<string, unknown> = {},
    data: Record<string, unknown> = {}
): Promise<unknown> {
    try {
        const response = await axiosInstance.request({
            method: method.toUpperCase(),
            url: path,
            params: params,
            data: data,
        });
        logger.info(`API call ${method.toUpperCase()} ${path} successful (Status: ${response.status})`);
        return response.data;
    } catch (error: unknown) {
        logger.error(`API call ${method.toUpperCase()} ${path} failed:`, error);
        let errorMessage = `n8n API request failed for ${method.toUpperCase()} ${path}.`;
        let errorCode = ErrorCode.InternalError;

        if (axios.isAxiosError(error)) {
            errorMessage = `n8n API error: ${error.response?.status} ${error.response?.statusText}. Response: ${JSON.stringify(error.response?.data)}`;
            if (error.response?.status === 401 || error.response?.status === 403) {
                errorCode = ErrorCode.InvalidRequest;
                errorMessage += " Check your N8N_API_KEY.";
            } else if (error.response?.status === 404) {
                errorCode = ErrorCode.InvalidRequest;
            } else if (error.response?.status && error.response.status >= 400 && error.response.status < 500) {
                errorCode = ErrorCode.InvalidParams;
            }
        } else if (error instanceof Error) {
            errorMessage += ` ${error.message}`;
        }
        throw new McpError(errorCode, errorMessage);
    }
}

// --- Tool Handlers ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allToolDefinitions };
});

// Tool name sets for routing
const workflowTools = new Set(workflowToolDefinitions.map(t => t.name));
const executionTools = new Set(executionToolDefinitions.map(t => t.name));
const credentialTools = new Set(credentialToolDefinitions.map(t => t.name));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info(`Executing tool: ${name}`, args);

    try {
        // Route to modular handlers
        if (workflowTools.has(name)) {
            return await handleWorkflowTool(name, args as Record<string, unknown>, axiosInstance);
        }
        if (executionTools.has(name)) {
            return await handleExecutionTool(name, args as Record<string, unknown>, axiosInstance);
        }
        if (credentialTools.has(name)) {
            return await handleCredentialTool(name, args as Record<string, unknown>, axiosInstance);
        }

        // Handle core tools
        switch (name) {
            case "search_api_endpoints": {
                const { query, limit = 10 } = args as { query: string, limit?: number };
                if (!query) throw new McpError(ErrorCode.InvalidParams, "Query is required.");

                const sql = `
                    SELECT id, path, method, summary, description, tags
                    FROM endpoints
                    WHERE path LIKE ? OR method LIKE ? OR summary LIKE ? OR description LIKE ? OR tags LIKE ?
                    ORDER BY path, method
                    LIMIT ?;
                `;
                const params = Array(5).fill(`%${query}%`).concat(limit);
                const rows = await dbAll(apiSpecDb, sql, params);
                return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
            }

            case "get_api_endpoint_details": {
                const { path, method } = args as { path: string, method: string };
                if (!path || !method) throw new McpError(ErrorCode.InvalidParams, "Path and method are required.");

                const sql = `SELECT * FROM endpoints WHERE path = ? AND method = ? LIMIT 1;`;
                const rows = await dbAll(apiSpecDb, sql, [path, method.toUpperCase()]) as Record<string, unknown>[];

                if (rows.length === 0) {
                    throw new McpError(ErrorCode.InvalidRequest, `Endpoint details not found in database: ${method.toUpperCase()} ${path}`);
                }

                const endpoint = rows[0];
                try {
                    if (typeof endpoint.parameters === 'string') endpoint.parameters = JSON.parse(endpoint.parameters);
                    if (typeof endpoint.requestBody === 'string') endpoint.requestBody = JSON.parse(endpoint.requestBody);
                    if (typeof endpoint.responses === 'string') endpoint.responses = JSON.parse(endpoint.responses);
                    if (typeof endpoint.tags === 'string') endpoint.tags = JSON.parse(endpoint.tags);
                } catch (parseError) {
                    console.warn(`Failed to parse JSON fields for endpoint ${method} ${path}`);
                }
                return { content: [{ type: "text", text: JSON.stringify(endpoint, null, 2) }] };
            }

            case "execute_api_call": {
                let { path, method, params, data } = args as {
                    path: string;
                    method: string;
                    params?: Record<string, unknown>;
                    data?: Record<string, unknown>;
                };
                if (!path || !method) throw new McpError(ErrorCode.InvalidParams, "Path and method are required.");

                // Check Fast Memory first
                const fastMemorySql = `SELECT * FROM fast_memory WHERE api_path = ? AND api_method = ? LIMIT 1`;
                const fastResults = await dbAll(fastMemoryDb, fastMemorySql, [path, method.toUpperCase()]) as FastMemoryEntry[];

                let lastCallFromFastMemory = false;
                let fastMemoryEntry: FastMemoryEntry | null = null;

                if (fastResults.length > 0) {
                    fastMemoryEntry = fastResults[0];
                    logger.info(`Found matching entry in fast memory (ID: ${fastMemoryEntry.id}) for ${method} ${path}`);
                    lastCallFromFastMemory = true;
                    if (!params && fastMemoryEntry.api_params) {
                        try { params = JSON.parse(fastMemoryEntry.api_params); } catch { /* ignore */ }
                    }
                    if (!data && fastMemoryEntry.api_data) {
                        try { data = JSON.parse(fastMemoryEntry.api_data); } catch { /* ignore */ }
                    }
                    dbRun(fastMemoryDb, `UPDATE fast_memory SET usage_count = usage_count + 1 WHERE id = ?`, [fastMemoryEntry.id])
                        .catch(err => logger.error(`Failed to increment usage count: ${err}`));
                }

                const result = await makeN8nApiRequest(method, path, params, data);

                let responseText = JSON.stringify(result, null, 2);
                let messagePrefix = "";
                let saveSuggestion = "";

                if (lastCallFromFastMemory && fastMemoryEntry) {
                    messagePrefix = `[Using query from Fast Memory: ${fastMemoryEntry.description || `ID ${fastMemoryEntry.id}`}]\n\n`;
                } else {
                    const paramsStr = params ? `, params: ${JSON.stringify(params)}` : '';
                    const dataStr = data ? `, data: ${JSON.stringify(data)}` : '';
                    saveSuggestion = `\n\n---\nAPI call successful. To save this to Fast Memory for future use:\n` +
                                     `save_to_fast_memory(description="YOUR_DESCRIPTION", api_path="${path}", api_method="${method.toUpperCase()}"${paramsStr}${dataStr})`;
                }

                const MAX_RESPONSE_LENGTH = 5000;
                if (responseText.length > MAX_RESPONSE_LENGTH) {
                    responseText = responseText.substring(0, MAX_RESPONSE_LENGTH) + "\n... (Response truncated)";
                }

                return { content: [{ type: "text", text: messagePrefix + responseText + saveSuggestion }] };
            }

            case "natural_language_api_search": {
                const { query, max_results = 5 } = args as { query: string, max_results?: number };
                if (!query) throw new McpError(ErrorCode.InvalidParams, "Query is required.");

                const fastMemorySql = `SELECT * FROM fast_memory WHERE natural_language_query LIKE ? LIMIT 1`;
                const fastResults = await dbAll(fastMemoryDb, fastMemorySql, [`%${query}%`]) as FastMemoryEntry[];

                if (fastResults.length > 0) {
                    const entry = fastResults[0];
                    console.log(`Found match in fast memory for query: "${query}"`);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                message: "Found match in fast memory.",
                                entry: {
                                    id: entry.id,
                                    natural_language_query: entry.natural_language_query,
                                    api_path: entry.api_path,
                                    api_method: entry.api_method,
                                    api_params: entry.api_params ? JSON.parse(entry.api_params) : undefined,
                                    api_data: entry.api_data ? JSON.parse(entry.api_data) : undefined,
                                    description: entry.description,
                                    created_at: entry.created_at,
                                }
                            }, null, 2)
                        }]
                    };
                }

                console.log(`No match in fast memory for query: "${query}". Searching API spec DB...`);
                const specSql = `
                    SELECT id, path, method, summary, description, tags
                    FROM endpoints
                    WHERE summary LIKE ? OR description LIKE ? OR path LIKE ? OR tags LIKE ?
                    ORDER BY length(summary)
                    LIMIT ?;
                `;
                const specParams = [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, max_results];
                const specResults = await dbAll(apiSpecDb, specSql, specParams);

                if ((specResults as unknown[]).length === 0) {
                     return { content: [{ type: "text", text: `No match found in fast memory or API spec for query: "${query}"` }] };
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            message: `Found potential matches in API spec database for query: "${query}"`,
                            results: specResults
                        }, null, 2)
                    }]
                };
            }

            case "save_to_fast_memory": {
                const {
                    natural_language_query,
                    api_path,
                    api_method,
                    api_params = {},
                    api_data = {},
                    description = ''
                } = args as {
                    natural_language_query: string;
                    api_path: string;
                    api_method: string;
                    api_params?: object;
                    api_data?: object;
                    description?: string;
                };

                if (!natural_language_query || !api_path || !api_method) {
                    throw new McpError(ErrorCode.InvalidParams, "natural_language_query, api_path, and api_method are required.");
                }

                const sql = `
                    INSERT INTO fast_memory (natural_language_query, api_path, api_method, api_params, api_data, description)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(natural_language_query) DO UPDATE SET
                        api_path = excluded.api_path,
                        api_method = excluded.api_method,
                        api_params = excluded.api_params,
                        api_data = excluded.api_data,
                        description = excluded.description,
                        created_at = CURRENT_TIMESTAMP;
                `;
                const sqlParams = [
                    natural_language_query,
                    api_path,
                    api_method.toUpperCase(),
                    JSON.stringify(api_params),
                    JSON.stringify(api_data),
                    description
                ];

                const result = await dbRun(fastMemoryDb, sql, sqlParams);
                const message = result.changes > 0 ? `Saved/Updated fast memory entry (ID: ${result.lastID}) for query: "${natural_language_query}"` : "Failed to save to fast memory (no changes detected).";
                console.log(message);
                return { content: [{ type: "text", text: message }] };
            }

            case "list_fast_memory": {
                const { search_term, limit = 20 } = args as { search_term?: string, limit?: number };
                let sql = `SELECT id, natural_language_query, api_path, api_method, description, created_at FROM fast_memory`;
                const sqlParams: unknown[] = [];

                if (search_term) {
                    sql += ` WHERE natural_language_query LIKE ? OR description LIKE ?`;
                    sqlParams.push(`%${search_term}%`, `%${search_term}%`);
                }
                sql += ` ORDER BY created_at DESC LIMIT ?`;
                sqlParams.push(limit);

                const rows = await dbAll(fastMemoryDb, sql, sqlParams);
                return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
            }

            case "delete_from_fast_memory": {
                const { id } = args as { id: number };
                if (typeof id !== 'number') throw new McpError(ErrorCode.InvalidParams, "A numeric ID is required.");

                const sql = `DELETE FROM fast_memory WHERE id = ?`;
                const result = await dbRun(fastMemoryDb, sql, [id]);

                const message = result.changes > 0 ? `Deleted fast memory entry with ID: ${id}` : `Fast memory entry with ID ${id} not found.`;
                console.log(message);
                return { content: [{ type: "text", text: message }] };
            }

            case "clear_fast_memory": {
                const sql = `DELETE FROM fast_memory;`;
                const vacuumSql = `VACUUM;`;
                const result = await dbRun(fastMemoryDb, sql);
                await dbRun(fastMemoryDb, vacuumSql);
                const message = `Cleared ${result.changes} entries from fast memory.`;
                logger.info(message);
                return { content: [{ type: "text", text: message }] };
            }

            case "send_raw_api_request": {
                const { raw_request } = args as { raw_request: string };
                if (!raw_request) throw new McpError(ErrorCode.InvalidParams, "raw_request string is required.");

                const parts = raw_request.trim().match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
                if (!parts) throw new McpError(ErrorCode.InvalidParams, "Invalid raw_request format. Use 'METHOD /path?query=val [JSON_BODY]'");

                const method = parts[1];
                const pathAndQuery = parts[2];
                const bodyString = parts[3];

                let path = pathAndQuery;
                let params: Record<string, unknown> = {};
                const queryIndex = pathAndQuery.indexOf('?');
                if (queryIndex !== -1) {
                    path = pathAndQuery.substring(0, queryIndex);
                    const queryString = pathAndQuery.substring(queryIndex + 1);
                    params = Object.fromEntries(new URLSearchParams(queryString));
                }

                let data: Record<string, unknown> | null = null;
                if (bodyString) {
                    try {
                        data = JSON.parse(bodyString);
                    } catch (e: unknown) {
                        const error = e as Error;
                        throw new McpError(ErrorCode.InvalidParams, `Invalid JSON body provided: ${error.message}`);
                    }
                }

                logger.info(`Executing raw request as: ${method} ${path}`, { params, data });
                const result = await makeN8nApiRequest(method, path, params, data || {});

                let responseText = JSON.stringify(result, null, 2);
                let saveSuggestion = "";

                const fastMemorySql = `SELECT id FROM fast_memory WHERE api_path = ? AND api_method = ? LIMIT 1`;
                const fastResults = await dbAll(fastMemoryDb, fastMemorySql, [path, method.toUpperCase()]);
                if ((fastResults as unknown[]).length === 0) {
                    const paramsStr = Object.keys(params).length > 0 ? `, api_params: ${JSON.stringify(params)}` : '';
                    const dataStr = data ? `, api_data: ${JSON.stringify(data)}` : '';
                    saveSuggestion = `\n\n---\nAPI call successful. To save this to Fast Memory for future use:\n` +
                                     `save_to_fast_memory(description="YOUR_DESCRIPTION", api_path="${path}", api_method="${method.toUpperCase()}"${paramsStr}${dataStr})`;
                }

                const MAX_RESPONSE_LENGTH = 5000;
                if (responseText.length > MAX_RESPONSE_LENGTH) {
                    responseText = responseText.substring(0, MAX_RESPONSE_LENGTH) + "\n... (Response truncated)";
                }

                return { content: [{ type: "text", text: responseText + saveSuggestion }] };
            }

            case "load_api_spec_from_json": {
                const { json_file_path } = args as { json_file_path: string };
                if (!json_file_path) throw new McpError(ErrorCode.InvalidParams, "JSON file path is required.");
                if (!json_file_path.toLowerCase().endsWith('.json')) {
                    throw new McpError(ErrorCode.InvalidParams, "Only .json files are allowed for security reasons.");
                }

                logger.info(`Attempting to load API spec from: ${json_file_path}`);

                let specContent: string;
                try {
                    specContent = await fs.readFile(json_file_path, 'utf-8');
                } catch (readError: unknown) {
                    const error = readError as Error;
                    console.error(`Failed to read API spec file: ${error.message}`);
                    throw new McpError(ErrorCode.InvalidParams, `Failed to read file at path: ${json_file_path}. Error: ${error.message}`);
                }

                let spec: OpenApiSpec;
                try {
                    spec = JSON.parse(specContent);
                    if (!spec.openapi || !spec.paths) {
                        throw new Error("Invalid OpenAPI format: Missing 'openapi' version or 'paths'.");
                    }
                    console.log(`Parsed OpenAPI spec version ${spec.openapi}, title: ${spec.info?.title}`);
                } catch (parseError: unknown) {
                    const error = parseError as Error;
                    console.error(`Failed to parse API spec JSON: ${error.message}`);
                    throw new McpError(ErrorCode.InvalidParams, `Failed to parse JSON from file: ${json_file_path}. Error: ${error.message}`);
                }

                const insertSql = `
                   INSERT OR REPLACE INTO endpoints (path, method, summary, description, parameters, requestBody, responses, tags)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                `;

                let endpointsAdded = 0;
                let endpointsFailed = 0;

                await dbRun(apiSpecDb, 'BEGIN TRANSACTION;');

                try {
                    for (const apiPath in spec.paths) {
                        const pathItem = spec.paths[apiPath];
                        for (const method in pathItem) {
                            if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(method.toLowerCase())) {
                                const endpointData = pathItem[method] as OpenApiPathItem;
                                const sqlParams = [
                                    apiPath,
                                    method.toUpperCase(),
                                    endpointData.summary || null,
                                    endpointData.description || null,
                                    endpointData.parameters ? JSON.stringify(endpointData.parameters) : null,
                                    endpointData.requestBody ? JSON.stringify(endpointData.requestBody) : null,
                                    endpointData.responses ? JSON.stringify(endpointData.responses) : null,
                                    endpointData.tags ? JSON.stringify(endpointData.tags) : null,
                                ];
                                try {
                                    await dbRun(apiSpecDb, insertSql, sqlParams);
                                    endpointsAdded++;
                                } catch (insertError: unknown) {
                                    const error = insertError as Error;
                                    console.error(`Failed to insert endpoint ${method.toUpperCase()} ${apiPath}: ${error.message}`);
                                    endpointsFailed++;
                                }
                            }
                        }
                    }
                    await dbRun(apiSpecDb, 'COMMIT;');
                    const message = `API Spec Load Complete. Added/Updated: ${endpointsAdded}, Failed: ${endpointsFailed}.`;
                    console.log(message);
                    return { content: [{ type: "text", text: message }] };

                } catch (transactionError: unknown) {
                    const error = transactionError as Error;
                    console.error("Transaction failed during API spec load:", error);
                    await dbRun(apiSpecDb, 'ROLLBACK;');
                    throw new McpError(ErrorCode.InternalError, `Database transaction failed during spec load: ${error.message}`);
                }
            }

            case "download_api_spec": {
                const OPENAPI_URL = "https://raw.githubusercontent.com/n8n-io/n8n-docs/main/docs/api/v1/openapi.yml";

                logger.info(`Downloading n8n OpenAPI spec from: ${OPENAPI_URL}`);

                // Download the YAML spec
                let yamlContent: string;
                try {
                    const response = await axios.get(OPENAPI_URL, { timeout: 30000 });
                    yamlContent = response.data;
                } catch (downloadError: unknown) {
                    const error = downloadError as Error;
                    throw new McpError(ErrorCode.InternalError, `Failed to download OpenAPI spec: ${error.message}`);
                }

                // Parse YAML to JSON
                let spec: OpenApiSpec;
                try {
                    // Dynamic import of yaml package
                    const yaml = await import('yaml');
                    spec = yaml.parse(yamlContent);
                    if (!spec.openapi || !spec.paths) {
                        throw new Error("Invalid OpenAPI format: Missing 'openapi' version or 'paths'.");
                    }
                    logger.info(`Parsed OpenAPI spec version ${spec.openapi}, title: ${spec.info?.title}`);
                } catch (parseError: unknown) {
                    const error = parseError as Error;
                    throw new McpError(ErrorCode.InternalError, `Failed to parse OpenAPI YAML: ${error.message}`);
                }

                // Load into database
                const insertSql = `
                   INSERT OR REPLACE INTO endpoints (path, method, summary, description, parameters, requestBody, responses, tags)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                `;

                let endpointsAdded = 0;
                let endpointsFailed = 0;

                await dbRun(apiSpecDb, 'BEGIN TRANSACTION;');

                try {
                    for (const apiPath in spec.paths) {
                        const pathItem = spec.paths[apiPath];
                        for (const method in pathItem) {
                            if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(method.toLowerCase())) {
                                const endpointData = pathItem[method] as OpenApiPathItem;
                                const sqlParams = [
                                    apiPath,
                                    method.toUpperCase(),
                                    endpointData.summary || null,
                                    endpointData.description || null,
                                    endpointData.parameters ? JSON.stringify(endpointData.parameters) : null,
                                    endpointData.requestBody ? JSON.stringify(endpointData.requestBody) : null,
                                    endpointData.responses ? JSON.stringify(endpointData.responses) : null,
                                    endpointData.tags ? JSON.stringify(endpointData.tags) : null,
                                ];
                                try {
                                    await dbRun(apiSpecDb, insertSql, sqlParams);
                                    endpointsAdded++;
                                } catch (insertError: unknown) {
                                    const error = insertError as Error;
                                    console.error(`Failed to insert endpoint ${method.toUpperCase()} ${apiPath}: ${error.message}`);
                                    endpointsFailed++;
                                }
                            }
                        }
                    }
                    await dbRun(apiSpecDb, 'COMMIT;');
                    const message = `OpenAPI Spec Downloaded and Loaded!\n\nSource: ${OPENAPI_URL}\nVersion: ${spec.openapi}\nTitle: ${spec.info?.title}\nEndpoints Added/Updated: ${endpointsAdded}\nFailed: ${endpointsFailed}`;
                    logger.info(message);
                    return { content: [{ type: "text", text: message }] };

                } catch (transactionError: unknown) {
                    const error = transactionError as Error;
                    console.error("Transaction failed during API spec load:", error);
                    await dbRun(apiSpecDb, 'ROLLBACK;');
                    throw new McpError(ErrorCode.InternalError, `Database transaction failed: ${error.message}`);
                }
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    } catch (error: unknown) {
        console.error(`Error executing tool '${name}':`, error);

        if (error instanceof McpError) {
            throw error;
        }

        let errorMessage = `Error executing tool '${name}'.`;
        if (axios.isAxiosError(error)) {
            errorMessage = `n8n API error: ${error.response?.status} ${error.response?.statusText}. ${JSON.stringify(error.response?.data)}`;
        } else if (error instanceof Error) {
            errorMessage += ` ${error.message}`;
        }

        return {
            content: [{ type: "text", text: errorMessage }],
            isError: true,
        };
    }
});

// --- Server Lifecycle ---
async function main() {
    try {
        await initializeServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.log("n8n MCP server connected via stdio.");
    } catch (error) {
        console.error("Failed to start n8n MCP server:", error);
        process.exit(1);
    }
}

async function shutdown() {
    console.log("Shutting down n8n MCP server...");
    try {
        await closeDatabases({ apiSpecDb, fastMemoryDb });
        await server.close();
        console.log("Server shut down gracefully.");
        process.exit(0);
    } catch (error) {
        console.error("Error during server shutdown:", error);
        process.exit(1);
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
