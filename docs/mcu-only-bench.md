# MCU-only ESP-NOW bench

Use the Waveshare receiver and a spare XIAO ESP32-C3 without probes. The separate
`bench/espnow` project exercises the production shared wire codec, encrypted
ESP-NOW adapter, pairing, ordering, freshness, and restart handling. It never
instantiates `SessionLogger`, mounts log storage, or changes probe mapping.
It is not the production logger and does not test acquisition or durable writes.

```sh
.venv/bin/pio run --project-dir bench/espnow
.venv/bin/pio run --project-dir bench/espnow --target upload --upload-port /dev/serial/by-id/ACTUAL_C3
```

The bench uses the Arduino framework's default clock and partitions. It does not
validate the production logger's external RTC crystal or custom storage layout.
Flash the production logger separately before testing those paths.

Pair using the normal `RADIO STATUS` and `tools/pair_radio.py` workflow. Samples
have expected count eight, an explicitly synthetic mapping, and SAUW status bit
8 (`synthetic_sample`). Use the updated receiver, which displays `BENCH`; older
receivers may ignore the new flag. No synthetic samples are written to raw logs.

Commands at 115200 baud:

- `BENCH STATUS`: runtime mode, sequence, and free heap.
- `BENCH PAUSE` / `BENCH RUN`: stop/resume offered packets while acquisition
  sequence continues; verifies missing-record accounting and freshness.
- `BENCH MISSING` / `BENCH VALID`: emit all-invalid/all-valid synthetic probes.
- `RADIO STATUS`, pairing configuration, and `RADIO REBOOT`: shared radio commands.

On the receiver, `RECEIVER STATUS` exposes accepted samples, sequence, freshness,
valid mask, synthetic flag, source, and boot nonce for automated checks. It does
not refresh sample age. Expect a new acquisition every ten seconds; after a pause
expect stale then lost at sixty seconds. Restarting the bench creates a fresh
untrusted boot nonce; receiver epoch confirmation can require two new samples.

Keep the receiver's displayed BENCH label visible during these tests. Passing
this bench does not qualify real probes, logging, sauna placement, or field range.

`BENCH TIMEOUT` drops the next send callback to test automatic radio recovery.
Use `RADIO RECOVER` to request radio-only recovery without resetting sample identity.
