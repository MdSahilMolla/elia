import { expect, test } from 'bun:test'
import { previewTool } from './preview.ts'

test('preview rejects when neither path nor url is given', async () => {
  await expect(previewTool.execute({})).rejects.toThrow('requires either')
})

test('preview rejects a non-http url', async () => {
  await expect(previewTool.execute({ url: 'file:///etc/passwd' })).rejects.toThrow('http or https')
})

test('preview rejects both path and url', async () => {
  await expect(previewTool.execute({ path: 'a.html', url: 'http://x' })).rejects.toThrow('only one of')
})

test('the description tells the model preview builds framework projects itself', () => {
  expect(previewTool.description).toContain('build')
  expect(previewTool.description.toLowerCase()).toContain('dev server')
})
