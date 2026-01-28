/**
 * Workflow management tools for n8n MCP
 * - list_workflows: List all workflows
 * - get_workflow: Get a single workflow by ID
 * - create_workflow: Create workflow with local JSON validation
 * - update_workflow: Update workflow with partial data support
 * - validate_workflow: Validate workflow JSON before submission
 * - activate_workflow: POST /workflows/{id}/activate
 * - deactivate_workflow: POST /workflows/{id}/deactivate
 */

import { AxiosInstance } from 'axios';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Types
interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  position: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  typeVersion?: number;
  [key: string]: unknown;
}

interface WorkflowConnections {
  [nodeName: string]: {
    [outputType: string]: Array<Array<{ node: string; type: string; index: number }>>;
  };
}

interface WorkflowData {
  name: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnections;
  settings?: Record<string, unknown>;
  staticData?: Record<string, unknown>;
  tags?: Array<{ id: string; name: string }>;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// Tool definitions
export const workflowToolDefinitions = [
  {
    name: "list_workflows",
    description: "List all workflows in the n8n instance with optional filtering.",
    inputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean", description: "Filter by active status (optional)" },
        limit: { type: "integer", description: "Maximum number of results (default: 100)", default: 100 },
        cursor: { type: "string", description: "Pagination cursor for next page (optional)" }
      },
      required: []
    }
  },
  {
    name: "get_workflow",
    description: "Get a workflow by ID, including all nodes, connections, and settings.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Workflow ID" }
      },
      required: ["id"]
    }
  },
  {
    name: "create_workflow",
    description: "Create a new n8n workflow with local JSON validation before submission.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workflow name" },
        nodes: { type: "array", description: "Array of workflow nodes" },
        connections: { type: "object", description: "Node connections object" },
        settings: { type: "object", description: "Workflow settings (default: {})", default: {} }
      },
      required: ["name", "nodes", "connections"]
    }
  },
  {
    name: "update_workflow",
    description: "Update an existing n8n workflow. Fetches existing workflow, merges updates, and saves.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Workflow ID to update" },
        name: { type: "string", description: "New workflow name (optional)" },
        nodes: { type: "array", description: "Updated nodes array (optional)" },
        connections: { type: "object", description: "Updated connections (optional)" },
        settings: { type: "object", description: "Updated settings (optional)" }
      },
      required: ["id"]
    }
  },
  {
    name: "validate_workflow",
    description: "Validate workflow JSON structure before submission. Checks required fields, node structure, connection references, and expression syntax.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: { type: "object", description: "Complete workflow JSON to validate" }
      },
      required: ["workflow"]
    }
  },
  {
    name: "activate_workflow",
    description: "Activate a workflow by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Workflow ID to activate" }
      },
      required: ["id"]
    }
  },
  {
    name: "deactivate_workflow",
    description: "Deactivate a workflow by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Workflow ID to deactivate" }
      },
      required: ["id"]
    }
  }
];

/**
 * Validate workflow JSON structure
 */
export function validateWorkflow(workflow: Partial<WorkflowData>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!workflow.name || typeof workflow.name !== 'string') {
    errors.push("Missing or invalid 'name' field (must be a non-empty string)");
  }

  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    errors.push("Missing or invalid 'nodes' field (must be an array)");
  } else {
    // Validate each node
    const nodeNames = new Set<string>();
    workflow.nodes.forEach((node, index) => {
      if (!node.id) {
        errors.push(`Node at index ${index} missing 'id' field`);
      }
      if (!node.name) {
        errors.push(`Node at index ${index} missing 'name' field`);
      } else {
        if (nodeNames.has(node.name)) {
          errors.push(`Duplicate node name: '${node.name}'`);
        }
        nodeNames.add(node.name);
      }
      if (!node.type) {
        errors.push(`Node '${node.name || index}' missing 'type' field`);
      }
      if (!node.position || !Array.isArray(node.position) || node.position.length !== 2) {
        errors.push(`Node '${node.name || index}' missing or invalid 'position' field (must be [x, y])`);
      }
      if (node.type && !node.type.includes('.')) {
        warnings.push(`Node '${node.name || index}' type '${node.type}' may be incomplete (expected format: 'n8n-nodes-base.nodeName')`);
      }
    });

    // Validate connections reference valid nodes
    if (workflow.connections && typeof workflow.connections === 'object') {
      for (const sourceName of Object.keys(workflow.connections)) {
        if (!nodeNames.has(sourceName)) {
          errors.push(`Connection source '${sourceName}' references non-existent node`);
        }
        const sourceConnections = workflow.connections[sourceName];
        if (sourceConnections) {
          for (const outputType of Object.keys(sourceConnections)) {
            const outputs = sourceConnections[outputType];
            if (Array.isArray(outputs)) {
              outputs.forEach((outputGroup, groupIdx) => {
                if (Array.isArray(outputGroup)) {
                  outputGroup.forEach((conn, connIdx) => {
                    if (conn.node && !nodeNames.has(conn.node)) {
                      errors.push(`Connection from '${sourceName}' references non-existent target node '${conn.node}'`);
                    }
                  });
                }
              });
            }
          }
        }
      }
    }
  }

  if (!workflow.connections || typeof workflow.connections !== 'object') {
    errors.push("Missing or invalid 'connections' field (must be an object)");
  }

  // Validate expression syntax (basic check for {{ }} balance)
  if (workflow.nodes && Array.isArray(workflow.nodes)) {
    workflow.nodes.forEach((node) => {
      if (node.parameters) {
        checkExpressions(node.parameters, node.name || 'unknown', errors, warnings);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Recursively check for expression syntax issues
 */
function checkExpressions(
  obj: unknown,
  nodeName: string,
  errors: string[],
  warnings: string[],
  path: string = ''
): void {
  if (typeof obj === 'string') {
    // Check for unbalanced {{ }}
    const openCount = (obj.match(/\{\{/g) || []).length;
    const closeCount = (obj.match(/\}\}/g) || []).length;
    if (openCount !== closeCount) {
      errors.push(`Node '${nodeName}' has unbalanced expression at ${path || 'root'}: ${openCount} '{{' vs ${closeCount} '}}'`);
    }
    // Check for common expression issues
    if (obj.includes('{{') && !obj.includes('}}')) {
      errors.push(`Node '${nodeName}' has unclosed expression at ${path || 'root'}`);
    }
    // Warn about empty expressions
    if (obj.includes('{{}}')) {
      warnings.push(`Node '${nodeName}' has empty expression '{{}}' at ${path || 'root'}`);
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      checkExpressions(item, nodeName, errors, warnings, `${path}[${index}]`);
    });
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      checkExpressions(value, nodeName, errors, warnings, path ? `${path}.${key}` : key);
    }
  }
}

/**
 * Handle workflow tool calls
 */
export async function handleWorkflowTool(
  name: string,
  args: Record<string, unknown>,
  axiosInstance: AxiosInstance
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "list_workflows": {
      const { active, limit = 100, cursor } = args as {
        active?: boolean;
        limit?: number;
        cursor?: string;
      };

      const params: Record<string, unknown> = { limit };
      if (active !== undefined) params.active = active;
      if (cursor) params.cursor = cursor;

      try {
        const response = await axiosInstance.get('/workflows', { params });
        const workflows = response.data.data || response.data;
        const nextCursor = response.data.nextCursor;

        const result = {
          count: Array.isArray(workflows) ? workflows.length : 0,
          nextCursor: nextCursor || null,
          workflows: Array.isArray(workflows) ? workflows.map((wf: Record<string, unknown>) => ({
            id: wf.id,
            name: wf.name,
            active: wf.active,
            createdAt: wf.createdAt,
            updatedAt: wf.updatedAt
          })) : workflows
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        const errorMsg = axiosError.response
          ? `n8n API error: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    case "get_workflow": {
      const { id } = args as { id: string };

      if (!id) {
        throw new McpError(ErrorCode.InvalidParams, "Workflow ID is required");
      }

      try {
        const response = await axiosInstance.get(`/workflows/${id}`);
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        if (axiosError.response?.status === 404) {
          throw new McpError(ErrorCode.InvalidParams, `Workflow ${id} not found`);
        }
        const errorMsg = axiosError.response
          ? `n8n API error: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    case "create_workflow": {
      const { name: workflowName, nodes, connections, settings = {} } = args as {
        name: string;
        nodes: WorkflowNode[];
        connections: WorkflowConnections;
        settings?: Record<string, unknown>;
      };

      // Validate before submission
      const workflow = { name: workflowName, nodes, connections, settings };
      const validation = validateWorkflow(workflow);

      if (!validation.valid) {
        return {
          content: [{
            type: "text",
            text: `Workflow validation failed:\n\nErrors:\n${validation.errors.map(e => `- ${e}`).join('\n')}${
              validation.warnings.length > 0 ? `\n\nWarnings:\n${validation.warnings.map(w => `- ${w}`).join('\n')}` : ''
            }`
          }]
        };
      }

      // Submit to n8n API
      try {
        const response = await axiosInstance.post('/workflows', workflow);
        let resultText = `Workflow created successfully!\n\nID: ${response.data.id}\nName: ${response.data.name}`;
        if (validation.warnings.length > 0) {
          resultText += `\n\nWarnings:\n${validation.warnings.map(w => `- ${w}`).join('\n')}`;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        const errorMsg = axiosError.response
          ? `n8n API error: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    case "update_workflow": {
      const { id, name, nodes, connections, settings } = args as {
        id: string;
        name?: string;
        nodes?: WorkflowNode[];
        connections?: WorkflowConnections;
        settings?: Record<string, unknown>;
      };

      if (!id) {
        throw new McpError(ErrorCode.InvalidParams, "Workflow ID is required");
      }

      // Fetch existing workflow to merge with updates
      let existing;
      try {
        existing = await axiosInstance.get(`/workflows/${id}`);
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        if (axiosError.response?.status === 404) {
          throw new McpError(ErrorCode.InvalidParams, `Workflow ${id} not found`);
        }
        throw error;
      }

      // Merge updates with existing workflow
      const merged = {
        name: name ?? existing.data.name,
        nodes: nodes ?? existing.data.nodes,
        connections: connections ?? existing.data.connections,
        settings: settings ?? existing.data.settings ?? {},
      };

      // Validate merged workflow
      const validation = validateWorkflow(merged);
      if (!validation.valid) {
        return {
          content: [{
            type: "text",
            text: `Workflow validation failed:\n\nErrors:\n${validation.errors.map(e => `- ${e}`).join('\n')}`
          }]
        };
      }

      // Submit update with full merged workflow
      try {
        const response = await axiosInstance.put(`/workflows/${id}`, merged);
        return {
          content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        const errorMsg = axiosError.response
          ? `n8n API error: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    case "validate_workflow": {
      const { workflow } = args as { workflow: Partial<WorkflowData> };

      if (!workflow || typeof workflow !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, "Workflow object is required");
      }

      const validation = validateWorkflow(workflow);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            valid: validation.valid,
            errors: validation.errors,
            warnings: validation.warnings,
            summary: validation.valid
              ? `Workflow is valid${validation.warnings.length > 0 ? ` with ${validation.warnings.length} warning(s)` : ''}`
              : `Workflow has ${validation.errors.length} error(s)${validation.warnings.length > 0 ? ` and ${validation.warnings.length} warning(s)` : ''}`
          }, null, 2)
        }]
      };
    }

    case "activate_workflow": {
      const { id } = args as { id: string };

      if (!id) {
        throw new McpError(ErrorCode.InvalidParams, "Workflow ID is required");
      }

      try {
        const response = await axiosInstance.post(`/workflows/${id}/activate`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: `Workflow ${id} activated successfully`,
              workflow: response.data
            }, null, 2)
          }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        const errorMsg = axiosError.response
          ? `Failed to activate workflow: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    case "deactivate_workflow": {
      const { id } = args as { id: string };

      if (!id) {
        throw new McpError(ErrorCode.InvalidParams, "Workflow ID is required");
      }

      try {
        const response = await axiosInstance.post(`/workflows/${id}/deactivate`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: `Workflow ${id} deactivated successfully`,
              workflow: response.data
            }, null, 2)
          }]
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; statusText: string; data: unknown }; message?: string };
        const errorMsg = axiosError.response
          ? `Failed to deactivate workflow: ${axiosError.response.status} ${axiosError.response.statusText}. ${JSON.stringify(axiosError.response.data)}`
          : `Request failed: ${axiosError.message || 'Unknown error'}`;
        throw new McpError(ErrorCode.InternalError, errorMsg);
      }
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown workflow tool: ${name}`);
  }
}
