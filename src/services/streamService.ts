import { jobService } from '@/services/jobService'

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
      if (onLine) {
        const mapped = onLine(line)
        if (typeof mapped === 'string') out = mapped
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
    }
    const msg = prefix ? `${prefix} ${out}` : out
    jobService.addRawLog(jobId, msg)
  }
}


