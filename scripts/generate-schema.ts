import { writeFileSync } from 'node:fs'
import { format, resolveConfig } from 'prettier'
import { configurationJSONSchema } from '../packages/contracts/src/configuration'

// Keep editor tooling derived from the maintained configuration contract.
const path = 'schemas/servitas.schema.json'
writeFileSync(
  path,
  await format(JSON.stringify(configurationJSONSchema()), {
    ...(await resolveConfig(path)),
    filepath: path,
  }),
)
