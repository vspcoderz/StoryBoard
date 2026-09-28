/** Registers the TypeScript resolve hook before the test runner loads any test file. */
import { register } from 'node:module'

register('./ts-resolve.mjs', import.meta.url)
