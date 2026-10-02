/**
 * Every onboarding string. The flow and wording follow the user's prototype ("Nasiko Console", screen "02 Onboarding"),
 * with the lab's naming: the platform is OpenRuntime, never a "control plane".
 */
import type { StepId } from './logic'
import type { Persona } from './types'

export const copy = {
  guide: {
    title: 'Starting guide',
    meta: 'About 3 minutes · all optional',
    rail: 'Getting started',
    step: (n: number, of: number) => `Step ${n} of ${of}`,
    skipGuide: 'Skip guide',
    close: 'Close the guide',
    back: 'Back',
    skipStep: 'Skip this step',
    getStarted: 'Get started',
    continue: 'Continue',
    finish: 'Go to Overview',
    left: (minutes: number) =>
      minutes
        ? `About ${minutes} min left · skip anytime`
        : 'All set · every answer can be changed',
  },
  steps: {
    welcome: { title: 'Welcome', sub: 'How OpenRuntime works' },
    role: { title: 'Your role', sub: 'Tailor the guide' },
    model: { title: 'Connect a model', sub: 'Provider and keys' },
    agent: { title: 'Bring an agent', sub: 'Zip, GitHub or registry' },
    ready: { title: 'Ready', sub: 'Start exploring' },
  } satisfies Record<StepId, { title: string; sub: string }>,
  welcome: {
    badge: 'New to Nasiko',
    title: "Welcome to Nasiko. Let's set up your workspace.",
    intro:
      'OpenRuntime runs, observes, secures and pays for AI agents on any framework. Work flows through it in four stages.',
    stages: [
      { title: 'Connect', line: 'Models, MCP tools and channels' },
      { title: 'Build', line: 'Import or create agents' },
      { title: 'Run', line: 'Orchestrate tasks end to end' },
      { title: 'Govern', line: 'Budgets, guardrails and traces' },
    ],
    note: 'The next steps set up the first stage. You can change every answer later.',
  },
  role: {
    title: "What's your role?",
    intro: "We'll suggest the page you need first.",
    label: 'Your role',
    opens: (page: string) => `Opens ${page}`,
    saveFailed: "Couldn't save your role. Try again.",
    retry: 'Try again',
    personas: {
      developer: {
        title: 'Developer',
        line: 'Build, test and ship agents from the CLI and console.',
      },
      platform_engineer: {
        title: 'Platform engineer',
        line: 'Run the cluster, routing and model providers.',
      },
      finance: { title: 'FinOps / Finance', line: 'Track AI spend, budgets and forecasts.' },
      engineering_manager: {
        title: 'Engineering manager',
        line: 'See which coding harnesses your teams use and what they cost.',
      },
      product_manager: {
        title: 'Product manager',
        line: 'Ask agents about users, funnels and feedback.',
      },
      data_analyst: {
        title: 'Data analyst',
        line: 'Follow usage and spend across agents and models.',
      },
      support_lead: { title: 'Support lead', line: 'Triage tickets and answer customers faster.' },
      sre: { title: 'SRE / On-call', line: 'Debug slow or failing agent runs from traces.' },
      leadership: { title: 'Leadership', line: 'One view of adoption, spend and results.' },
    } satisfies Record<Persona, { title: string; line: string }>,
  },
  model: {
    title: 'Connect a model provider',
    intro:
      'Agents route every call through the OpenRuntime gateway. Add more providers later in the LLM router.',
    label: 'Model provider',
    models: (n: number) => `${n} model${n === 1 ? '' : 's'}`,
    key: (provider: string) => `${provider} API key`,
    // Each provider's key format, as the prototype shows it.
    placeholder: { openai: 'sk-proj-…', anthropic: 'sk-ant-…', gemini: 'AIza…' } as Record<
      string,
      string
    >,
    placeholderOther: 'Paste your API key',
    connect: 'Connect',
    connecting: 'Connecting…',
    connected: (what: string) =>
      `Connected · ${what} is now your default model through the gateway`,
    keyEmpty: 'Paste a key first, or skip this step and add it later.',
    later: 'You can add the key later',
    vault: 'The key is saved as one of your secrets and never shown again.',
    noProviders: 'No model providers are available on this server yet.',
    loadFailed: 'the model providers',
    saveFailed: (reason: string) => `Couldn't connect: ${reason}`,
  },
  agent: {
    title: 'Bring your first agent',
    intro: 'Every agent goes through the same lifecycle, whichever way it arrives.',
    upload: 'Upload a zip',
    github: 'GitHub',
    registry: 'Registry',
    lifecycle: 'Lifecycle',
    stages: ['Source', 'Build', 'Deploy', 'Live'],
    started: 'Your agent is on its way. We will let you know when the build finishes.',
    openBuild: 'Open the build',
    openAgent: 'Open the agent',
  },
  ready: {
    title: 'Your workspace is ready',
    intro: 'Here is what we set up. Everything can be changed later.',
    role: 'Role',
    model: 'Model',
    agent: 'Agent',
    skipped: 'Skipped',
    building: 'Building',
    edit: (what: string) => `Edit ${what.toLowerCase()}`,
    editShort: 'Edit',
    overview: 'Open the Overview',
    overviewLine: 'Spend, sessions and agent health',
    open: (page: string) => `Open ${page}`,
    openLine: 'Your suggested first screen',
  },
  card: {
    title: 'Setup guide',
    intro: 'Finish setting up your workspace. Every step is optional.',
    resume: 'Resume guide',
    done: 'Done',
    todo: 'Not yet',
  },
}
