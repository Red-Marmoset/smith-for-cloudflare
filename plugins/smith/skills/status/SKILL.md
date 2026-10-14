---
name: status
description: Show recent Smith builds and which build machines are online.
argument-hint: "[project]"
disable-model-invocation: true
---

Summarize Smith's current state for: $ARGUMENTS

Call `list_builds` (filtered to the given project, if any) and `list_machines`. Report the most
recent builds with their state, machine and age, any builds still running, and which machines are
online and able to run builds. Keep it to a short table or list.
