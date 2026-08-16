import { z } from 'zod';

const token = z.string().min(32).max(512).refine((value) => !value.startsWith('change-me'), 'placeholder secret is forbidden');

export const ApiConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(3000),
  ownerId: z.string().min(1).max(100).default('owner'),
  bearerToken: token,
  runnerUrl: z.url(),
  runnerToken: token,
  publicHosts: z.array(z.string().min(1)).min(1),
  allowedOrigins: z.array(z.url()).default([]),
  requestTimeoutMs: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  maxBodyBytes: z.coerce.number().int().min(1_024).max(4_194_304).default(1_048_576)
});

export const RunnerConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(3001),
  serviceToken: token,
  jobsRoot: z.string().min(1),
  stateDb: z.string().min(1),
  executorImage: z.string().min(1),
  allowedGitHosts: z.array(z.string().min(1)).min(1),
  networkMode: z.enum(['none', 'bridge']).default('none'),
  wallTtlSeconds: z.coerce.number().int().min(60).max(86_400).default(900),
  idleTtlSeconds: z.coerce.number().int().min(30).max(43_200).default(300),
  maxOutputBytes: z.coerce.number().int().min(1_024).max(10_485_760).default(262_144),
  minFreeBytes: z.coerce.number().int().min(104_857_600).default(2_147_483_648),
  maxWorkspaceBytes: z.coerce.number().int().min(104_857_600).default(2_147_483_648),
  reaperIntervalSeconds: z.coerce.number().int().min(10).max(3_600).default(30),
  githubApp: z.object({
    appId: z.coerce.number().int().positive(),
    installationId: z.coerce.number().int().positive(),
    privateKey: z.string().includes('PRIVATE KEY').max(32_768)
  }).optional()
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
