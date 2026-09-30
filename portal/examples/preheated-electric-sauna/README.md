# Preheated electric sauna

A real eight-height recording, archived from the logger on 1 October 2026.
The owner describes an electrically heated sauna that was fully hot before
recording began. Useful observations start at approximately 15 minutes; earlier
readings are retained as setup/settling context, not a cold-start heating test.
The actual recording date and absolute wall-clock times are not established.

Open the portal's **Analyze → Try a real sauna recording** example, or select
all three `.slog` files together. Sessions 5 → 6 → 7 form one probable
power-restoration chain. Both gaps have unknown duration. The chart's observed
time excludes those gaps, so the owner's 15-minute guide is approximate; it
must not be treated as a recovered wall-clock timestamp.

| Segment | Records | Recorded relative time | State |
| --- | ---: | --- | --- |
| [5](session-5.slog) | 16 | −150 to 0 seconds | Interrupted |
| [6](session-6.slog) | 4 | −30 to 0 seconds | Interrupted |
| [7](session-7.slog) | 364 | −30 to 3600 seconds | Interrupted |

The last segment spans 60.5 minutes and has a top-probe peak of 77.81 °C.
Probe 1 is the highest probe; probes descend at 20 cm intervals. All three raw
files passed transfer CRC and header/block CRC validation with no parser
warnings. No bytes, samples, sensor identities or timestamps were changed.
An interrupted ending does not establish how long recording continued after
the last committed block.

[metadata.json](metadata.json) records the context, file sizes and SHA-256
hashes. These raw examples are intentionally public with the owner's permission;
other recordings and private radio-pairing kits are not part of this example.
