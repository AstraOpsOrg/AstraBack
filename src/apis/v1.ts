import { Hono } from "hono"
import { streamSSE } from 'hono/streaming'
import type { DeployRequest, DeployResponse } from '@/types'
import { jobService } from '@/services/jobService'
import { deploymentWorker } from '@/workers/deploymentWorker'
import { simulateInfrastructureSetup, simulateApplicationDeployment } from '@/workers/simulations'
import { logStreamService } from '@/services/logStreamService'
import { validateDeployRequest } from '@/validators/deployRequestValidator'
import { formatDateEs } from "@/utils/date"
import { setupMonitoringAndGetUrl } from '@/services/monitoringService'
import { runTerraformDestroy } from '@/services/destroy'

const version = '1'

function loadV1(app: Hono) {

  app.get(`/v${version}`, (ctx) => {
    return ctx.json({
      message: `AstraOps API v${version}`,
      version: version,
      status: 'healthy',
      timestamp: formatDateEs(new Date()),
      metrics: {
        activeJobs: jobService.getAllJobs().filter(j => j.status === 'RUNNING' || j.status === 'PENDING').length,
        totalJobs: jobService.getAllJobs().length
      }
    })
  })
  
  app.post(`/v${version}/deploy`, async (ctx) => {
    try {
      const requestBody = await ctx.req.json().catch(() => undefined)
      
      const validation = validateDeployRequest(requestBody)
      
      if (!validation.isValid) {
        return ctx.json({
          status: 400,
          errors: validation.errors
        }, 400)
      }

      // Create job with validated request
      const deployRequest = requestBody as DeployRequest
      const job = jobService.createJob(deployRequest)
      
      // Start unified deployment in background
      deploymentWorker.executeDeployment(job.id, deployRequest)
        .catch(error => {
          console.error(`Background ${job.id} error:`, error)
        })

      // Return immediate response
      const response: DeployResponse = {
        jobId: job.id,
        status: job.status,
        phases: job.phases,
        message: `Deployment initiated using provided IAM role for account ${deployRequest.accountId}`
      }

      return ctx.json(response, 202)

    } catch (error) {
      console.error('Deploy endpoint error:', error)
      
      return ctx.json({
        status: 500,
        errors: ['Internal server error']
      }, 500)
    }
  })

  app.post(`/v${version}/destroy`, async (ctx) => {
    try {
      const requestBody = await ctx.req.json().catch(() => undefined)
      const validation = validateDeployRequest(requestBody)
      if (!validation.isValid) {
        return ctx.json({ status: 400, errors: validation.errors }, 400)
      }
      const destroyRequest = requestBody as DeployRequest
      const job = jobService.createJob(destroyRequest)

      ;(async () => {
        try {
          jobService.updateJobStatus(job.id, 'RUNNING')
          jobService.updatePhaseStatus(job.id, 'auth', 'RUNNING')
          jobService.addLog(job.id, { phase: 'auth', level: 'info', message: `Using temporary AWS credentials provided by CLI` })
          jobService.updatePhaseStatus(job.id, 'auth', 'COMPLETED')

          jobService.updatePhaseStatus(job.id, 'infrastructureSetup', 'RUNNING')
          const creds = destroyRequest.awsCredentials
            ? {
                AccessKeyId: destroyRequest.awsCredentials.accessKeyId,
                SecretAccessKey: destroyRequest.awsCredentials.secretAccessKey,
                SessionToken: destroyRequest.awsCredentials.sessionToken,
              }
            : undefined
          if (!creds) throw new Error('No AWS STS credentials provided')
          const ok = await runTerraformDestroy(job.id, destroyRequest, creds)
          jobService.updatePhaseStatus(job.id, 'infrastructureSetup', ok.success ? 'COMPLETED' : 'FAILED')
          jobService.updatePhaseStatus(job.id, 'applicationDeploy', 'SKIPPED')
          jobService.updateJobStatus(job.id, ok.success ? 'COMPLETED' : 'FAILED')
          jobService.addLog(job.id, { phase: ok.success ? 'deployment' : 'error', level: ok.success ? 'success' : 'error', message: ok.success ? 'Destroy completed successfully' : 'Destroy failed' })
        } catch (e) {
          jobService.updatePhaseStatus(job.id, 'infrastructureSetup', 'FAILED')
          jobService.updateJobStatus(job.id, 'FAILED')
          jobService.addLog(job.id, { phase: 'error', level: 'error', message: 'Destroy failed' })
        }
      })()

      return ctx.json({ jobId: job.id, status: job.status, phases: job.phases, message: 'Destroy initiated' }, 202)
    } catch (e) {
      return ctx.json({ status: 500, errors: ['Internal server error'] }, 500)
    }
  })

  // Get job status
  app.get(`/v${version}/deploy/:jobId/status`, (ctx) => {
    const jobId = ctx.req.param('jobId')
    const job = jobService.getJob(jobId)

    if (!job) {
      return ctx.json({
        status: 404,
        errors: ['Job not found']
      }, 404)
    }

    const response: DeployResponse = {
      jobId: job.id,
      status: job.status,
      phases: job.phases,
      message: job.status === 'COMPLETED' 
        ? `Deployment completed successfully in ${jobService.getJobDuration(jobId)}`
        : job.status === 'FAILED'
        ? 'Deployment failed'
        : 'Deployment in progress'
    }

    if (job.status === 'COMPLETED' || job.status === 'FAILED') {
      response.duration = jobService.getJobDuration(jobId)
    }

    return ctx.json(response)
  })

  // Server-Sent Events endpoint for real-time logs
  app.get(`/v${version}/deploy/:jobId/logs`, (ctx) => {
    console.log(
      `\x1b[36m[ASTRAOPS-SSE]\x1b[0m Starting SSE for \x1b[33m${ctx.req.param('jobId')}\x1b[0m`
    )
    const jobId = ctx.req.param('jobId')
    const job = jobService.getJob(jobId)

    if (!job) {
      return ctx.json({
        status: 404,
        errors: ['Job not found']
      }, 404)
    }

    return streamSSE(ctx, async (stream) => {
      try {
        // Send existing logs first
        for (const log of job.logs) {
          await stream.writeSSE({
            data: JSON.stringify(log),
            event: 'log'
          })
        }

        // Subscribe to in-process log stream for this jobId
        let isActive = true
        let resolved = false
        let pendingResolve: (() => void) | null = null
        const cleanupAndResolve = (resolveFn: () => void) => {
          if (resolved) return
          isActive = false
          try { unsubscribe() } catch {}
          try { unsubscribeRaw() } catch {}
          clearInterval(heartbeatInterval)
          resolved = true
          resolveFn()
        }

        const shouldCloseOnLog = (logMessage: any) => {
          const msg = String(logMessage?.message || '')
          const phase = String(logMessage?.phase || '')
          const level = String(logMessage?.level || '')
          if (phase === 'deployment' && level === 'success' && msg.startsWith('Deployment completed successfully')) return true
          if (phase === 'error' && level === 'error' && msg.startsWith('Deployment failed')) return true
          return false
        }

        const unsubscribe = logStreamService.subscribeToLogs(jobId, (logMessage) => {
          if (!isActive) return
          stream.writeSSE({ data: JSON.stringify(logMessage), event: 'log' })
            .then(() => {
              if (shouldCloseOnLog(logMessage)) {
                // Defer a tick to ensure client consumes the final event
                setTimeout(() => pendingResolve && cleanupAndResolve(pendingResolve), 0)
              }
            })
            .catch(err => {
              console.error('SSE write error:', err)
              if (pendingResolve) cleanupAndResolve(pendingResolve)
            })
        })

        // Subscribe to raw lines (unstructured output)
        const unsubscribeRaw = logStreamService.subscribeToRaw(jobId, (line) => {
          if (!isActive) return
          stream.writeSSE({ data: line, event: 'raw' }).catch(err => {
            console.error('SSE raw write error:', err)
            if (pendingResolve) cleanupAndResolve(pendingResolve)
          })
        })

        // Send heartbeat every 30 seconds
        const heartbeatInterval = setInterval(() => {
          if (isActive) {
            const ts = formatDateEs(new Date())
            stream.writeSSE({
              data: `[${ts}] [heartbeat]`,
              event: 'raw'
            }).catch(() => {
              if (pendingResolve) cleanupAndResolve(pendingResolve)
            })
          } else {
            clearInterval(heartbeatInterval)
          }
        }, 30000)

        // If job already finished before we subscribed, close after replay
        const latest = jobService.getJob(jobId)
        if (latest && latest.status !== 'RUNNING' && latest.status !== 'PENDING') {
          setTimeout(() => pendingResolve && cleanupAndResolve(pendingResolve), 50)
        }

        // Keep the stream open until client disconnects
        await new Promise<void>((resolve) => {
          pendingResolve = resolve
          stream.onAbort(() => {
            if (pendingResolve) cleanupAndResolve(pendingResolve)
          })
        })
        

      } catch (error) {
        console.error('SSE setup error:', error)
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            message: 'Failed to setup log stream'
          }),
          event: 'error'
        })
      }
    })
  })

  // Server-Sent Events endpoint for real-time logs (destroy)
  app.get(`/v${version}/destroy/:jobId/logs`, (ctx) => {
    console.log(
      `\x1b[36m[ASTRAOPS-SSE]\x1b[0m Starting SSE (destroy) for \x1b[33m${ctx.req.param('jobId')}\x1b[0m`
    )
    const jobId = ctx.req.param('jobId')
    const job = jobService.getJob(jobId)

    if (!job) {
      return ctx.json({
        status: 404,
        errors: ['Job not found']
      }, 404)
    }

    return streamSSE(ctx, async (stream) => {
      try {
        // Send existing logs first
        for (const log of job.logs) {
          await stream.writeSSE({
            data: JSON.stringify(log),
            event: 'log'
          })
        }

        // Subscribe to in-process log stream for this jobId
        let isActive = true
        let resolved = false
        let pendingResolve: (() => void) | null = null
        const cleanupAndResolve = (resolveFn: () => void) => {
          if (resolved) return
          isActive = false
          try { unsubscribe() } catch {}
          try { unsubscribeRaw() } catch {}
          clearInterval(heartbeatInterval)
          resolved = true
          resolveFn()
        }

        const shouldCloseOnLog = (logMessage: any) => {
          const msg = String(logMessage?.message || '')
          const phase = String(logMessage?.phase || '')
          const level = String(logMessage?.level || '')
          if (phase === 'deployment' && level === 'success' && msg.startsWith('Destroy completed successfully')) return true
          if (phase === 'error' && level === 'error' && msg.startsWith('Destroy failed')) return true
          return false
        }

        const unsubscribe = logStreamService.subscribeToLogs(jobId, (logMessage) => {
          if (!isActive) return
          stream.writeSSE({ data: JSON.stringify(logMessage), event: 'log' })
            .then(() => {
              if (shouldCloseOnLog(logMessage)) {
                setTimeout(() => pendingResolve && cleanupAndResolve(pendingResolve), 0)
              }
            })
            .catch(err => {
              console.error('SSE write error (destroy):', err)
              if (pendingResolve) cleanupAndResolve(pendingResolve)
            })
        })

        const unsubscribeRaw = logStreamService.subscribeToRaw(jobId, (line) => {
          if (!isActive) return
          stream.writeSSE({ data: line, event: 'raw' }).catch(err => {
            console.error('SSE raw write error (destroy):', err)
            if (pendingResolve) cleanupAndResolve(pendingResolve)
          })
        })

        const heartbeatInterval = setInterval(() => {
          if (isActive) {
            const ts = formatDateEs(new Date())
            stream.writeSSE({
              data: `[${ts}] [heartbeat]`,
              event: 'raw'
            }).catch(() => {
              if (pendingResolve) cleanupAndResolve(pendingResolve)
            })
          } else {
            clearInterval(heartbeatInterval)
          }
        }, 30000)

        const latest = jobService.getJob(jobId)
        if (latest && latest.status !== 'RUNNING' && latest.status !== 'PENDING') {
          setTimeout(() => pendingResolve && cleanupAndResolve(pendingResolve), 50)
        }

        await new Promise<void>((resolve) => {
          pendingResolve = resolve
          stream.onAbort(() => {
            if (pendingResolve) cleanupAndResolve(pendingResolve)
          })
        })

      } catch (error) {
        console.error('SSE setup error (destroy):', error)
        await stream.writeSSE({
          data: JSON.stringify({ type: 'error', message: 'Failed to setup destroy log stream' }),
          event: 'error'
        })
      }
    })
  })

  // Cleanup old jobs on demand 
  app.post(`/v${version}/debug/jobs/cleanup`, async (ctx) => {
    const url = new URL(ctx.req.url)
    const hoursParam = url.searchParams.get('hours')
    const hours = hoursParam ? Math.max(0, parseInt(hoursParam)) : 24
    const cleanedJobs = jobService.cleanupOldJobs(hours)
    return ctx.json({ status: 200, cleanedJobsOlderThanHours: hours, cleanedJobs: cleanedJobs }, 200)
  })

  // List all jobs (for debugging)
  app.get(`/v${version}/debug/jobs`, (ctx) => {
    const jobs = jobService.getAllJobs().map((job) => ({
      ...job,
      duration: (job.status === 'COMPLETED' || job.status === 'FAILED')
        ? jobService.getJobDuration(job.id)
        : undefined
    }))
    return ctx.json({ status: 200, jobs }, 200)
  })
  
  // Simulation-only endpoint: runs infrastructure + application simulations with raw logs
  app.post(`/v${version}/deploy/simulate`, async (ctx) => {
    try {
      const requestBody = await ctx.req.json().catch(() => undefined)
      const validation = validateDeployRequest(requestBody)
      if (!validation.isValid) {
        return ctx.json({ status: 400, errors: validation.errors }, 400)
      }

      const deployRequest = requestBody as DeployRequest
      const job = jobService.createJob(deployRequest)

      // Kick off simulated flow in background
      ;(async () => {
        try {
          // Auth simulated as skipped
          jobService.updateJobStatus(job.id, 'RUNNING')
          jobService.updatePhaseStatus(job.id, 'auth', 'SKIPPED')

          // Infra simulation with some raw lines
          jobService.updatePhaseStatus(job.id, 'infrastructureSetup', 'RUNNING')
          jobService.addRawLog(job.id, 'terraform: Initializing the backend...')
          jobService.addRawLog(job.id, 'terraform: Initializing provider plugins...')
          await simulateInfrastructureSetup(job.id, deployRequest)
          jobService.addRawLog(job.id, 'terraform: Plan: 12 to add, 0 to change, 0 to destroy.')
          jobService.addRawLog(job.id, 'terraform: Apply complete! Resources: 12 added, 0 changed, 0 destroyed.')
          jobService.updatePhaseStatus(job.id, 'infrastructureSetup', 'COMPLETED')

          // App simulation with some raw lines
          jobService.updatePhaseStatus(job.id, 'applicationDeploy', 'RUNNING')
          jobService.addRawLog(job.id, 'kubectl: Using prebuilt images from astraops.yaml')
          await simulateApplicationDeployment(job.id, deployRequest)
          jobService.addRawLog(job.id, 'kubectl: Applying manifests...')
          jobService.addRawLog(job.id, 'kubectl: rollout status deployment/demo-frontend: success')
          jobService.updatePhaseStatus(job.id, 'applicationDeploy', 'COMPLETED')

          // Complete job
          jobService.addLog(job.id, { phase: 'deployment', level: 'success', message: 'Deployment completed successfully' })
          jobService.updateJobStatus(job.id, 'COMPLETED')
        } catch (e) {
          jobService.addLog(job.id, { phase: 'error', level: 'error', message: 'Deployment failed' })
          jobService.updateJobStatus(job.id, 'FAILED')
        }
      })()

      const response: DeployResponse = {
        jobId: job.id,
        status: job.status,
        phases: job.phases,
        message: `Simulation initiated for account ${deployRequest.accountId}`
      }
      return ctx.json(response, 202)
    } catch (error) {
      console.error('Deploy simulate endpoint error:', error)
      return ctx.json({ status: 500, errors: ['Internal server error'] }, 500)
    }
  })

  // Setup monitoring (Grafana) after successful deploy
  app.post(`/v${version}/deploy/:jobId/monitoring`, async (ctx) => {
    try {
      const jobId = ctx.req.param('jobId')
      const job = jobService.getJob(jobId)
      if (!job) return ctx.json({ status: 404, errors: ['Job not found'] }, 404)
      if (job.status !== 'COMPLETED') return ctx.json({ status: 409, errors: ['Job is not completed'] }, 409)

      const ns = String(job.request.astraopsConfig?.applicationName)
      const region = String(job.request.region)
      const clusterName = String(job.request.astraopsConfig?.applicationName)

      // Use the job credentials (STS) to install the stack in the user cluster
      const credentials = (deploymentWorker as any).getJobCredentials?.call?.(deploymentWorker, jobId) || undefined
      if (!credentials) return ctx.json({ status: 500, errors: ['No credentials available to access user cluster'] }, 500)

      const url = await setupMonitoringAndGetUrl(ns, region, clusterName, {
        AccessKeyId: credentials.AccessKeyId,
        SecretAccessKey: credentials.SecretAccessKey,
        SessionToken: credentials.SessionToken,
      }, jobId)
      return ctx.json({ status: 200, url }, 200)
    } catch (e: any) {
      console.error('Monitoring setup error:', e?.message || e)
      return ctx.json({ status: 500, errors: ['Monitoring setup failed'] }, 500)
    }
  })
  
  
  
}

export default loadV1
