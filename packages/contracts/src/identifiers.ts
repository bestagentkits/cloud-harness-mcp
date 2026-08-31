import { z } from 'zod';

const opaqueId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{20,80}$`), `invalid ${prefix} identifier`);

export const WorkspaceIdSchema = opaqueId('ws').brand<'WorkspaceId'>();
export const OperationIdSchema = opaqueId('op').brand<'OperationId'>();
export const ShellIdSchema = opaqueId('sh').brand<'ShellId'>();
export const SessionIdSchema = opaqueId('sess').brand<'SessionId'>();
export const TaskIdSchema = opaqueId('task').brand<'TaskId'>();
export const AgentIdSchema = opaqueId('agent').brand<'AgentId'>();
export const AgentLeaseIdSchema = opaqueId('lease').brand<'AgentLeaseId'>();
export const AgentMessageIdSchema = opaqueId('msg').brand<'AgentMessageId'>();
export const IdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type ShellId = z.infer<typeof ShellIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type AgentLeaseId = z.infer<typeof AgentLeaseIdSchema>;
export type AgentMessageId = z.infer<typeof AgentMessageIdSchema>;

export const ExecutorNetworkProfileSchema = z.enum(['network-none', 'dependency-access']);
export type ExecutorNetworkProfile = z.infer<typeof ExecutorNetworkProfileSchema>;

export const WorkspaceNetworkExposureSchema = z.enum(['network-none', 'dependency-access', 'local-host']);
export type WorkspaceNetworkExposure = z.infer<typeof WorkspaceNetworkExposureSchema>;
