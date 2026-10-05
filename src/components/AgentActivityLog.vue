<script setup lang="ts">
import { Check, ChevronDown, Circle, LoaderCircle, Sparkles, Terminal, Wrench, X } from 'lucide-vue-next'
import { computed, ref, useId, watch } from 'vue'
import type { AgentActivityEvent } from '../types'

const props = withDefaults(defineProps<{
  activities: AgentActivityEvent[]
  title?: string
  collapsed?: boolean
  compact?: boolean
}>(), {
  title: 'AI 活动',
  collapsed: true,
  compact: false,
})

const expanded = ref(!props.collapsed)
const listId = useId()
watch(() => props.collapsed, (collapsed) => { expanded.value = !collapsed })
const orderedActivities = computed(() => [...props.activities].reverse().sort((left, right) => left.createdAt - right.createdAt))
const runningActivity = computed(() => [...orderedActivities.value].reverse().find((activity) => activity.state === 'running'))
const hasError = computed(() => props.activities.some((activity) => activity.state === 'error'))
const summary = computed(() => {
  if (runningActivity.value) return runningActivity.value.title
  if (hasError.value) return `含 ${props.activities.filter((activity) => activity.state === 'error').length} 项错误`
  return `${props.activities.length} 项活动`
})

function activityIcon(activity: AgentActivityEvent) {
  if (activity.state === 'running') return LoaderCircle
  if (activity.state === 'error' || activity.kind === 'error') return X
  if (activity.kind === 'tool') return Wrench
  if (activity.kind === 'model' || activity.kind === 'stream') return Sparkles
  if (activity.kind === 'result') return Check
  if (activity.kind === 'status') return Terminal
  return Circle
}

function activityTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
</script>

<template>
  <section v-if="props.activities.length" :class="['agent-event-log', { compact: props.compact, expanded }]">
    <button class="agent-event-log-toggle" type="button" :aria-expanded="expanded" :aria-controls="listId" @click.stop="expanded = !expanded">
      <LoaderCircle v-if="runningActivity" class="spin" :size="13" />
      <Terminal v-else :size="13" />
      <strong>{{ props.title }}</strong>
      <span>{{ summary }}</span>
      <ChevronDown :class="{ rotated: expanded }" :size="13" />
    </button>
    <ol v-if="expanded" :id="listId" class="agent-event-log-list">
      <li v-for="activity in orderedActivities" :key="activity.id" :class="['agent-event-log-item', `agent-event-log-${activity.state}`]">
        <span class="agent-event-log-icon"><component :is="activityIcon(activity)" :class="{ spin: activity.state === 'running' }" :size="13" /></span>
        <div class="agent-event-log-copy"><strong>{{ activity.title }}</strong><p v-if="activity.detail">{{ activity.detail }}</p></div>
        <time>{{ activityTime(activity.createdAt) }}</time>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.agent-event-log { min-width: 0; margin-top: 9px; overflow: hidden; border: 1px solid var(--theme-border); border-radius: 7px; color: var(--theme-font); background: var(--theme-surface); }
.agent-event-log-toggle { width: 100%; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 0; color: var(--theme-font); background: transparent; text-align: left; cursor: pointer; }
.agent-event-log-toggle:hover { background: var(--theme-hover); }
.agent-event-log-toggle > svg { flex: 0 0 auto; color: var(--theme-button); }
.agent-event-log-toggle strong { flex: 0 0 auto; color: var(--theme-font); font-size: 11px; font-weight: 600; }
.agent-event-log-toggle > span { min-width: 0; flex: 1; overflow: hidden; color: var(--theme-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.agent-event-log-toggle > svg:last-child { color: var(--theme-font); transition: transform .15s ease; }
.agent-event-log-toggle > svg.rotated { transform: rotate(180deg); }
.agent-event-log-list { max-height: 280px; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 4px 10px 10px; overflow: auto; overscroll-behavior: contain; list-style: none; }
.agent-event-log-item { min-width: 0; display: grid; grid-template-columns: 17px minmax(0, 1fr) auto; align-items: start; gap: 6px; font-size: 11px; }
.agent-event-log-icon { width: 17px; height: 17px; display: grid; place-items: center; color: var(--theme-muted); }
.agent-event-log-copy { min-width: 0; padding-top: 1px; }
.agent-event-log-copy strong { display: block; color: var(--theme-font); font-size: 11px; font-weight: 500; line-height: 1.45; overflow-wrap: anywhere; }
.agent-event-log-copy p { margin: 3px 0 0; color: var(--theme-muted); font-size: 10px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-event-log-item time { padding-top: 3px; color: var(--theme-muted); font-size: 9px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.agent-event-log-running .agent-event-log-icon { color: var(--theme-button); }
.agent-event-log-done .agent-event-log-icon { color: var(--theme-success, var(--theme-button)); }
.agent-event-log-error .agent-event-log-icon { color: var(--theme-danger, var(--theme-button)); }
.agent-event-log.compact { border: 0; background: transparent; }
.agent-event-log.compact .agent-event-log-toggle { padding-inline: 0; }
.agent-event-log.compact .agent-event-log-toggle:hover { background: transparent; }
.agent-event-log.compact .agent-event-log-list { padding-inline: 0; }
.agent-event-log.compact .agent-event-log-item { grid-template-columns: 17px minmax(0, 1fr); }
.agent-event-log.compact .agent-event-log-item time { display: none; }
</style>
