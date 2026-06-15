<img width="1270" height="940" alt="playsongMixer" src="https://github.com/user-attachments/assets/b8a16db2-407d-4b25-bf01-718f506a89a0" />

# Stem Mixer

`stem_mixer` is a Slopsmith plugin that adds a single **Mixer** button to the player controls and replaces individual stem volume buttons with a compact mixing panel.

## Features

- Per-stem volume controls for:
  - Guitar
  - Bass
  - Voice
  - Drums
  - Piano
  - Other
- 8-band graphic EQ.
- EQ profiles with dropdown selection.
- `Output autolevel` toggle to keep output loudness more consistent.
- Local persistence via `localStorage` (volumes, EQ, autolevel, selected profile).
<img width="1270" height="940" alt="globalsettings" src="https://github.com/user-attachments/assets/a29736a4-65f0-4cc8-8e86-dcffc15f92c5" />
## Requirements

`stem_mixer` depends on the `stems` plugin. Install it first:

```bash
cd plugins
git clone https://github.com/topkoa/slopsmith-plugin-stems.git stems
```

## Installation

After installing `stems`, add this plugin in `plugins/stem_mixer` and restart the Slopsmith container.

