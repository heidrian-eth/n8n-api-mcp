/**
 * Credential management tools for n8n MCP
 * - list_credentials: GET /credentials
 * - get_credential_schema: GET /credentials/schema/{type}
 */

import { AxiosInstance } from 'axios';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Tool definitions
export const credentialToolDefinitions = [
  {
    name: "list_credentials",
    description: "List all available credentials in the n8n instance. Returns credential metadata (not sensitive data). Note: May not be available on n8n Cloud.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maximum number of results (default: 100)", default: 100 },
        cursor: { type: "string", description: "Pagination cursor for next page (optional)" }
      },
      required: []
    }
  },
  {
    name: "get_credential_schema",
    description: "Get the configuration schema for a specific credential type. Useful for understanding what fields are required when creating credentials.",
    inputSchema: {
      type: "object",
      properties: {
        credentialType: {
          type: "string",
          description: "Credential type name (e.g., 'slackOAuth2Api', 'httpBasicAuth', 'googleSheetsOAuth2Api')"
        }
      },
      required: ["credentialType"]
    }
  }
];

/**
 * Handle credential tool calls
 */
export async function handleCredentialTool(
  name: string,
  args: Record<string, unknown>,
  axiosInstance: AxiosInstance
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "list_credentials": {
      const { limit = 100, cursor } = args as { limit?: number; cursor?: string };

      const params: Record<string, unknown> = { limit };
      if (cursor) params.cursor = cursor;

      try {
        const response = await axiosInstance.get('/credentials', { params });

        const credentials = response.data.data || response.data;
        const nextCursor = response.data.nextCursor;

        // Format response with useful metadata
        const result = {
          count: Array.isArray(credentials) ? credentials.length : 0,
          nextCursor: nextCursor || null,
          credentials: Array.isArray(credentials) ? credentials.map((cred: Record<string, unknown>) => ({
            id: cred.id,
            name: cred.name,
            type: cred.type,
            createdAt: cred.createdAt,
            updatedAt: cred.updatedAt
          })) : credentials
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        if (axiosError.response?.status === 405) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "GET /credentials is not available on n8n Cloud. Use get_credential_schema to get schema for specific credential types, or check credentials in the n8n UI."
          );
        }
        const errorMsg = axiosError.response
          ? `n8n API error: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    case "get_credential_schema": {
      const { credentialType } = args as { credentialType: string };

      if (!credentialType) {
        throw new McpError(ErrorCode.InvalidParams, "Credential type is required");
      }

      try {
        const response = await axiosInstance.get(`/credentials/schema/${credentialType}`);

        // Return the schema with some helpful context
        const result = {
          credentialType,
          schema: response.data,
          usage: `Use this schema to understand the required fields when creating a '${credentialType}' credential. Note: Credentials can only be created through the n8n UI due to encryption requirements.`
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        if (axiosError.response?.status === 404) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Credential type '${credentialType}' not found. Common types include: 'httpBasicAuth', 'httpHeaderAuth', 'oAuth2Api', 'slackOAuth2Api', 'googleSheetsOAuth2Api', 'notionApi'`
          );
        }
        const errorMsg = axiosError.response
          ? `n8n API error: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown credential tool: ${name}`);
  }
}
