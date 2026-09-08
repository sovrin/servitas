import { createAppSchema, type AppManifest } from './index'

export interface AppTemplate {
  id: string
  title: string
  description: string
  version: string
  documentation: string
  notes: string
  manifest: AppManifest
}

// Reviewed defaults use the ordinary deployment contract; templates add no runtime privileges.
export const appTemplates: AppTemplate[] = [
  {
    id: 'memos',
    title: 'Memos',
    version: '0.30.0',
    description: 'Personal notes with Markdown and local attachments.',
    documentation: 'https://usememos.com/docs/deploy/docker',
    notes:
      'Open the app and create its owner account. Notes, accounts, and uploaded attachments are saved in the data volume. Keep the app private while completing setup.',
    manifest: createAppSchema.parse({
      manifest: {
        version: 1,
        name: 'memos',
        source: {
          type: 'image',
          image:
            'neosmemo/memos:0.30.0@sha256:71a5b4738d1bed96e92112004054f0888e92791b64eb78afd79077c96e6f9327',
        },
        port: 5230,
        resources: { memoryMb: 256, cpu: 1 },
        volumes: [{ name: 'data', mountPath: '/var/opt/memos' }],
      },
    }).manifest,
  },
  {
    id: 'uptime-kuma',
    title: 'Uptime Kuma',
    version: '2.5.3',
    description: 'Website availability monitoring and status history.',
    documentation: 'https://github.com/louislam/uptime-kuma/wiki',
    notes:
      'Choose SQLite during first setup, create its administrator account, then add HTTP or TCP monitors. Settings and history are saved in the data volume. Docker socket monitoring is not supported. Public status pages require publishing the whole app.',
    manifest: createAppSchema.parse({
      manifest: {
        version: 1,
        name: 'uptime-kuma',
        source: {
          type: 'image',
          image:
            'louislam/uptime-kuma:2.5.3@sha256:3e24e96c89efff0e3a4b0698cbdd36c15ad3022371db57166e5588853002ee5c',
        },
        port: 3001,
        resources: { memoryMb: 512, cpu: 1 },
        volumes: [{ name: 'data', mountPath: '/app/data' }],
      },
    }).manifest,
  },
  {
    id: 'it-tools',
    title: 'IT Tools',
    version: '2024.10.22-7ca5933',
    description: 'Everyday converters, generators, and developer utilities.',
    documentation: 'https://github.com/CorentinTh/it-tools',
    notes:
      'No app account is needed. This app has no server data volume; preferences live in your browser and are not included in server backups.',
    manifest: createAppSchema.parse({
      manifest: {
        version: 1,
        name: 'it-tools',
        source: {
          type: 'image',
          image:
            'corentinth/it-tools:2024.10.22-7ca5933@sha256:8b8128748339583ca951af03dfe02a9a4d7363f61a216226fc28030731a5a61f',
        },
        port: 80,
        resources: { memoryMb: 128, cpu: 0.5 },
      },
    }).manifest,
  },
]
