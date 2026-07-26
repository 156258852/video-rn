---
kind: business_term
name: Business Glossary
category: business_term
scope:
    - '**'
---

### virtual stitching
- Definition：The core technique of playing multiple MP4 clips sequentially while treating them as one continuous timeline, where total duration equals sum of per-clip durations and scrubbing works across clip boundaries seamlessly
- Aliases：virtual timeline、stitched playback

### POC
- Definition：Proof of Concept - a demo project used to validate technical feasibility rather than production code; this project name StitchRNPOCModern indicates it's a modern React Native proof of concept
- Aliases：proof of concept、demo

### slot
- Definition：One of two Video player instances used in the dual-player strategy; active slot plays current clip while inactive slot preloads next clip for seamless transitions
- Aliases：player slot、video slot

### seekToken
- Definition：Incrementing counter used to track seek requests and prevent stale events from affecting playback state after user seeks to different positions
- Aliases：seek token、seek counter

### appliedSeekToken
- Definition：Token value set when SEEK_APPLIED action occurs, indicating the native player has received the seek command and is processing it
- Aliases：applied token

### seekJustApplied
- Definition：Boolean flag set during the window between SEEK_APPLIED and first PROGRESS event, used to filter out stale END events that might occur during native seek completion
- Aliases：seek applied flag

### isSeeking
- Definition：User gesture state indicating whether user is currently dragging the scrubber; orthogonal to playback phase and used to gate PROGRESS/END events during drag operations
- Aliases：seeking state、dragging

### loadedPendingSeek
- Definition：Phase where clip is loaded but pending seek operation needs to be executed before transitioning to seeking or ready state
- Aliases：pending seek phase

### endHitPatch
- Definition：State patch applied when clip ends and next clip is already preloaded (hit), enabling seamless transition without loading delay
- Aliases：end hit patch

### endMissPatch
- Definition：State patch applied when clip ends but next clip needs to be loaded (miss), causing transition to loading phase
- Aliases：end miss patch

### progressGuard
- Definition：Validation function that filters out stale PROGRESS events based on seekToken matching, isSeeking state, and seekJustApplied window
- Aliases：progress validation

### totalSafe
- Definition：Sanitized total duration value used for UI calculations to prevent division by zero and ensure valid scrubber behavior
- Aliases：safe total、validated total

### virtualTime
- Definition：Continuous time axis calculated as offsets[currentIndex] + currentTime, representing position in the stitched timeline
- Aliases：stitched time、timeline time

### sequenceEndCount
- Definition：Counter tracking how many times the entire video sequence has completed, used for completion detection and business logic
- Aliases：completion count、sequence counter

### playedSecondsRef
- Definition：Reference tracking accumulated natural progress deltas for completion detection, excluding large time jumps from seeks
- Aliases：watched seconds、accumulated time
