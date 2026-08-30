/**
 * CloudHarness Isolation Technology Benchmark Harness (Opt-in Linux KVM Execution)
 *
 * This harness is designed to execute on bare-metal Linux hosts with /dev/kvm
 * to gather empirical evidence for ADR 0001. When executed without prerequisites
 * or without RUN_ISOLATION_BENCHMARKS=true, it records host diagnostics and skips
 * rather than fabricating synthetic data.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

export interface BenchmarkEnvironmentRecord {
  timestamp: string;
  platform: string;
  arch: string;
  cpuModel: string;
  status: 'benchmarks_pending_kvm_host' | 'evidence_collected';
  totalMemoryBytes: number;
  hasKvm: boolean;
  hasDocker: boolean;
  hasFirecracker: boolean;
  prerequisitesMet: boolean;
  status: 'evidence_collected' | 'prerequisites_unmet_skipped';
}

export interface LiveBenchmarkResult {
  environment: BenchmarkEnvironmentRecord;
  samples: Array<{
    target: string;
    coldBootMs?: number;
    residentMemoryBytes?: number;
    rawOutput?: string;
    error?: string;
  }>;
}

export function inspectBenchmarkEnvironment(): BenchmarkEnvironmentRecord {
  const isLinux = platform() === 'linux';
  const hasKvm = isLinux && existsSync('/dev/kvm');

  const dockerCheck = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  const hasDocker = dockerCheck.status === 0;

  const fcCheck = spawnSync('firecracker', ['--version'], { encoding: 'utf8' });
  const hasFirecracker = fcCheck.status === 0;

  const cpuList = cpus();
  const cpuModel = cpuList.length > 0 ? cpuList[0].model : 'unknown';

  const prerequisitesMet = isLinux && hasKvm && hasDocker;

  return {
    timestamp: new Date().toISOString(),
    platform: platform(),
    arch: arch(),
    cpuModel,
    cpuCores: cpuList.length,
    totalMemoryBytes: totalmem(),
    hasKvm,
    hasDocker,
    hasFirecracker,
    prerequisitesMet,
    status: (prerequisitesMet && process.env.RUN_ISOLATION_BENCHMARKS === 'true') ? 'evidence_collected' : 'benchmarks_pending_kvm_host'
  };
}

export function runIsolationBenchmarkHarness(outputPath?: string): LiveBenchmarkResult {
  const env = inspectBenchmarkEnvironment();
  const result: LiveBenchmarkResult = {
    environment: env,
    samples: []
  };

  if (!env.prerequisitesMet || process.env.RUN_ISOLATION_BENCHMARKS !== 'true') {
    // Record honest skipped state with diagnostics
    if (outputPath) {
      writeFileSync(outputPath, JSON.stringify(result, null, 2));
    }
    return result;
  }

  try {
    const t0 = performance.now();
    const dockerRun = spawnSync('docker', ['run', '--rm', 'alpine:latest', 'echo', 'ready'], {
      encoding: 'utf8',
      timeout: 10000
    });
    const t1 = performance.now();

    result.samples.push({
      target: 'docker-baseline',
      coldBootMs: Math.round(t1 - t0),
      rawOutput: dockerRun.stdout?.trim(),
      error: dockerRun.status !== 0 ? dockerRun.stderr : undefined
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    result.samples.push({
      target: 'docker-baseline',
      error: errorMessage
    });
  }

  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(result, null, 2));
  }

  return result;
}
