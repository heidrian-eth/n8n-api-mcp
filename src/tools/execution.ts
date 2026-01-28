/**
 * Execution management tools for n8n MCP
 * - list_executions: GET /executions with filters
 * - get_execution: GET /executions/{id}
 */

import { AxiosInstance } from 'axios';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Tool definitions
export const executionToolDefinitions = [
  {
    name: "list_executions",
    description: "List workflow executions with optional filters for workflow ID, status, and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", description: "Filter by workflow ID (optional)" },
        status: {
          type: "string",
          description: "Filter by status: 'error', 'success', 'waiting' (optional)",
          enum: ["error", "success", "waiting"]
        },
        limit: { type: "integer", description: "Maximum number of results (default: 20)", default: 20 },
        cursor: { type: "string", description: "Pagination cursor for next page (optional)" },
        includeData: { type: "boolean", description: "Include execution data in response (default: false)", default: false }
      },
      required: []
    }
  },
  {
    name: "get_execution",
    description: "Get detailed information about a specific workflow execution, including input/output data.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Execution ID" },
        includeData: { type: "boolean", description: "Include full execution data (default: true)", default: true }
      },
      required: ["id"]
    }
  }
];

/**
 * Handle execution tool calls
 */
export async function handleExecutionTool(
  name: string,
  args: Record<string, unknown>,
  axiosInstance: AxiosInstance
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "list_executions": {
      const {
        workflowId,
        status,
        limit = 20,
        cursor,
        includeData = false
      } = args as {
        workflowId?: string;
        status?: 'error' | 'success' | 'waiting';
        limit?: number;
        cursor?: string;
        includeData?: boolean;
      };

      // Build query params
      const params: Record<string, unknown> = { limit };
      if (workflowId) params.workflowId = workflowId;
      if (status) params.status = status;
      if (cursor) params.cursor = cursor;
      if (includeData) params.includeData = includeData;

      try {
        const response = await axiosInstance.get('/executions', { params });

        // Format response with summary
        const executions = response.data.data || response.data;
        const nextCursor = response.data.nextCursor;

        const summary = {
          count: Array.isArray(executions) ? executions.length : 0,
          filters: {
            workflowId: workflowId || 'all',
            status: status || 'all',
            limit
          },
          nextCursor: nextCursor || null,
          executions: Array.isArray(executions) ? executions.map((exec: Record<string, unknown>) => ({
            id: exec.id,
            workflowId: exec.workflowId,
            status: exec.status,
            mode: exec.mode,
            startedAt: exec.startedAt,
            stoppedAt: exec.stoppedAt,
            finished: exec.finished,
            ...(includeData ? { data: exec.data } : {})
          })) : executions
        };

        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        const errorMsg = axiosError.response
          ? `n8n API error: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    case "get_execution": {
      const { id, includeData = true } = args as { id: string; includeData?: boolean };

      if (!id) {
        throw new McpError(ErrorCode.InvalidParams, "Execution ID is required");
      }

      try {
        const params: Record<string, unknown> = {};
        if (includeData) params.includeData = true;

        const response = await axiosInstance.get(`/executions/${id}`, { params });

        const execution = response.data;

        // Format with summary info
        const result = {
          id: execution.id,
          workflowId: execution.workflowId,
          workflowName: execution.workflowData?.name,
          status: execution.status,
          mode: execution.mode,
          startedAt: execution.startedAt,
          stoppedAt: execution.stoppedAt,
          finished: execution.finished,
          retryOf: execution.retryOf,
          retrySuccessId: execution.retrySuccessId,
          ...(includeData && execution.data ? {
            executionData: {
              resultData: execution.data.resultData,
              executionTime: execution.data.executionTime
            }
          } : {})
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        if (axiosError.response?.status === 404) {
          throw new McpError(ErrorCode.InvalidParams, `Execution ${id} not found`);
        }
        const errorMsg = axiosError.response
          ? `n8n API error: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown execution tool: ${name}`);
  }
}
