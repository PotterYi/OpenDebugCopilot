<template>
  <button @click="submit">submit</button>
</template>

<script setup>
export function submit() {
  throw new Error('inventory ui boom');
}
</script>
