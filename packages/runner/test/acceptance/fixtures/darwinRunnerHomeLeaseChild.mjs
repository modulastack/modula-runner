import { createFileRunnerHomeStorage } from '../../../dist/index.js'

const root = process.argv[2]
if (!root) throw new Error('runner home root argument is required')

const storage = createFileRunnerHomeStorage({ defaultRoot: root })

try {
  await storage.inspect({})
  const acquired = await storage.acquire()
  if (process.send) process.send({ acquired })
  if (acquired !== 'acquired') process.exit(2)
  setInterval(() => undefined, 1_000)
} catch (error) {
  if (process.send) process.send({ error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}
