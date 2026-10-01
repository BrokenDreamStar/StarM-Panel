<script setup lang="ts">
/**
 * 「系统状态」分区 —— 一排硬件卡片 + 点击后的详情弹窗。
 *
 * 卡片清单完全由设置驱动（见 composables/useStatCards）。
 */
import { ref } from 'vue'
import { useStatCards, type StatCardRef } from '@/composables/useStatCards'
import SystemStatCard from './SystemStatCard.vue'
import SystemStatDetail from './SystemStatDetail.vue'

const { cards } = useStatCards()

const active = ref<StatCardRef | null>(null)
const showDetail = ref(false)

function open(card: StatCardRef): void {
  active.value = card
  showDetail.value = true
}
</script>

<template>
  <section class="status-section">
    <h2 class="section-title">系统状态</h2>

    <div v-if="cards.length > 0" class="stat-grid">
      <SystemStatCard
        v-for="card in cards"
        :key="`${card.kind}:${card.mount ?? ''}`"
        :kind="card.kind"
        :mount="card.mount"
        @open="open(card)"
      />
    </div>
    <p v-else class="section-hint dim">
      未选择任何硬件卡片 —— 可在「设置 → 监控 → 系统状态卡片」中开启。
    </p>

    <SystemStatDetail v-model:show="showDetail" :card="active" />
  </section>
</template>

<style scoped>
.status-section {
  margin-bottom: var(--sp-7);
}

.stat-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
}

.section-hint {
  margin: 0;
  font-size: 12px;
}
</style>
