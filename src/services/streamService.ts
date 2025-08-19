import { jobService } from '@/services/jobService'

// Utility to hide absolute host paths from command outputs
function cleanHostPaths(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return ''
  let out = trimmed
  out = out.replaceAll('\\', '/')
  const cwd = process.cwd().replaceAll('\\', '/').replace(/\/$/, '')
  if (cwd) out = out.replaceAll(cwd + '/', '')
  const iacIdx = out.indexOf('/iac/') >= 0 ? out.indexOf('/iac/') : out.indexOf('iac/')
  if (iacIdx >= 0) {
    out = out.slice(iacIdx)
  } else {
    const replaceAbsPaths = (text: string) =>
      text.replace(/(\/[\w.-][^\s:]*|[A-Za-z]:\/[^^\s:]*)/g, (m) => {
        if (/^[a-z]+:\/\//i.test(m)) return m
        const parts = m.split('/')
        return parts[parts.length - 1] || m
      })
    out = replaceAbsPaths(out)
  }
  return out
}

export async function streamRaw(
  jobId: string,
  prefix: string,
  stream?: ReadableStream,
  onLine?: (line: string) => string | void
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      let out = line
      // Apply custom line transformation if provided
      if (onLine) {
        const mapped = onLine(line)
        if (typeof mapped === 'string') out = mapped
      } else {
        // Default: clean host paths from output
        out = cleanHostPaths(line)
      }
      const msg = prefix ? `${prefix} ${out}` : out
      jobService.addRawLog(jobId, msg)
    }
  }
  if (buffer) {
    let out = buffer
    if (onLine) {
      const mapped = onLine(buffer)
      if (typeof mapped === 'string') out = mapped
    } else {
      out = cleanHostPaths(buffer)
    }
    const msg = prefix ? `${prefix} ${out}` : out
    jobService.addRawLog(jobId, msg)
  }
}


