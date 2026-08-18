"""Pure analysis and offline Plotly reporting for sauna logger sessions."""

from __future__ import annotations

import html
import json
import math
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


HEIGHT_COLORS = [
    "#D1495B", "#ED8B16", "#E9C46A", "#69A85F",
    "#20A39E", "#348AA7", "#5B6FB5", "#8064A2",
]
THRESHOLDS = (40.0, 60.0, 80.0, 100.0)


@dataclass(frozen=True)
class Point:
    observed_seconds: float
    segment: int
    relative_seconds: int
    temperatures_c: tuple[float | None, ...]
    chip_temperature_c: float | None
    status_flags: int


@dataclass(frozen=True)
class Run:
    sessions: tuple[Any, ...]
    points: tuple[Point, ...]
    breaks: tuple[float, ...]
    warnings: tuple[str, ...]

    @property
    def sensors(self) -> list[Any]:
        return self.sessions[0].sensors

    @property
    def label(self) -> str:
        ids = [str(session.session_id) for session in self.sessions]
        noun = "session" if len(ids) == 1 else "sessions"
        return "Sauna " + noun + " " + " → ".join(ids)


def build_run(sessions: Iterable[Any]) -> Run:
    ordered = tuple(sessions)
    if not ordered:
        raise ValueError("a run needs at least one session")
    reference = [(sensor.rom, sensor.relative_height_cm) for sensor in ordered[0].sensors]
    warnings: list[str] = []
    points: list[Point] = []
    breaks: list[float] = []
    previous_end: float | None = None
    for segment, session in enumerate(ordered):
        layout = [(sensor.rom, sensor.relative_height_cm) for sensor in session.sensors]
        if layout != reference:
            raise ValueError(f"session {session.session_id} has a different sensor layout")
        warnings.extend(f"session {session.session_id}: {warning}" for warning in session.warnings)
        if not session.samples:
            warnings.append(f"session {session.session_id}: no committed samples")
            continue
        first = session.samples[0].relative_seconds
        offset = 0.0 if previous_end is None else previous_end - first
        if previous_end is not None:
            breaks.append(previous_end)
        for sample in session.samples:
            points.append(Point(
                sample.relative_seconds + offset, segment, sample.relative_seconds,
                sample.temperatures_c, sample.chip_temperature_c, sample.status_flags,
            ))
        previous_end = points[-1].observed_seconds
    return Run(ordered, tuple(points), tuple(breaks), tuple(warnings))


def _median(values: Iterable[float]) -> float | None:
    valid = list(values)
    return statistics.median(valid) if valid else None


def rolling_median(run: Run, probe: int, radius: int = 2) -> list[float | None]:
    result: list[float | None] = []
    for index, point in enumerate(run.points):
        values = []
        for candidate in run.points[max(0, index - radius): index + radius + 1]:
            if candidate.segment != point.segment:
                continue
            value = candidate.temperatures_c[probe]
            if value is not None and abs(candidate.observed_seconds - point.observed_seconds) <= 20:
                values.append(value)
        result.append(statistics.median(values) if len(values) >= 3 else None)
    return result


def linear_regression(xs: list[float], ys: list[float]) -> tuple[float, float] | None:
    if len(xs) < 2 or len(xs) != len(ys):
        return None
    x_mean, y_mean = statistics.fmean(xs), statistics.fmean(ys)
    denominator = sum((x - x_mean) ** 2 for x in xs)
    if denominator == 0:
        return None
    slope = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys)) / denominator
    predicted = [y_mean + slope * (x - x_mean) for x in xs]
    total = sum((y - y_mean) ** 2 for y in ys)
    residual = sum((y - estimate) ** 2 for y, estimate in zip(ys, predicted))
    r_squared = 1.0 if total == 0 else max(0.0, 1.0 - residual / total)
    return slope, r_squared


def vertical_metrics(run: Run) -> tuple[list[float | None], list[float | None], list[float | None]]:
    heights_m = [sensor.relative_height_cm / 100.0 for sensor in run.sensors]
    gradients: list[float | None] = []
    fits: list[float | None] = []
    spreads: list[float | None] = []
    for point in run.points:
        pairs = [(height, temperature) for height, temperature in zip(heights_m, point.temperatures_c)
                 if temperature is not None]
        fit = linear_regression([p[0] for p in pairs], [p[1] for p in pairs]) if len(pairs) >= 4 else None
        gradients.append(fit[0] if fit else None)
        fits.append(fit[1] if fit else None)
        top, bottom = point.temperatures_c[0], point.temperatures_c[-1]
        spreads.append(top - bottom if top is not None and bottom is not None else None)
    return gradients, fits, spreads


def _window_slopes(run: Run, probe: int) -> list[float | None]:
    slopes: list[float | None] = [None] * len(run.points)
    segments: dict[int, list[int]] = {}
    for index, point in enumerate(run.points):
        segments.setdefault(point.segment, []).append(index)
    for indices in segments.values():
        left = right = 0
        for position, center_index in enumerate(indices):
            center_time = run.points[center_index].observed_seconds
            while left < len(indices) and run.points[indices[left]].observed_seconds < center_time - 60:
                left += 1
            right = max(right, position)
            while right + 1 < len(indices) and run.points[indices[right + 1]].observed_seconds <= center_time + 60:
                right += 1
            pairs = [(run.points[index].observed_seconds / 60.0,
                      run.points[index].temperatures_c[probe])
                     for index in indices[left:right + 1]
                     if run.points[index].temperatures_c[probe] is not None]
            fit = linear_regression([p[0] for p in pairs], [p[1] for p in pairs]) if len(pairs) >= 9 else None
            slopes[center_index] = fit[0] if fit else None
    return slopes


def rapid_warming_candidates(run: Run) -> list[dict[str, float]]:
    slopes = [_window_slopes(run, probe) for probe in range(4)]
    composite: list[float | None] = []
    for index in range(len(run.points)):
        values = [probe[index] for probe in slopes if probe[index] is not None]
        composite.append(statistics.median(values) if len(values) >= 2 else None)
    valid = [value for value in composite if value is not None]
    if not valid:
        return []
    baseline = statistics.median(valid)
    mad = statistics.median(abs(value - baseline) for value in valid)
    threshold = max(1.0, baseline + 3.0 * mad)
    peaks: list[tuple[int, float]] = []
    for index, value in enumerate(composite):
        if value is None or value < threshold:
            continue
        left = composite[index - 1] if index else None
        right = composite[index + 1] if index + 1 < len(composite) else None
        if (left is None or value >= left) and (right is None or value >= right):
            peaks.append((index, value))
    clustered: list[tuple[int, float]] = []
    for index, value in peaks:
        if clustered and run.points[index].observed_seconds - run.points[clustered[-1][0]].observed_seconds <= 300:
            if value > clustered[-1][1]:
                clustered[-1] = (index, value)
        else:
            clustered.append((index, value))
    return [{"observed_seconds": run.points[index].observed_seconds,
             "rate_c_per_min": round(value, 3), "threshold_c_per_min": round(threshold, 3)}
            for index, value in clustered]


def _duration_above(run: Run, probe: int, threshold: float) -> float:
    seconds = 0.0
    for first, second in zip(run.points, run.points[1:]):
        if first.segment != second.segment or second.observed_seconds - first.observed_seconds > 20:
            continue
        a, b = first.temperatures_c[probe], second.temperatures_c[probe]
        if a is None or b is None:
            continue
        dt = second.observed_seconds - first.observed_seconds
        if a >= threshold and b >= threshold:
            seconds += dt
        elif (a >= threshold) != (b >= threshold) and a != b:
            fraction = abs((threshold - a) / (b - a))
            seconds += dt * (1.0 - fraction if a < threshold else fraction)
    return seconds / 60.0


def analyze_run(run: Run) -> dict[str, Any]:
    gradients, fits, spreads = vertical_metrics(run)
    events = rapid_warming_candidates(run)
    probes = []
    for probe, sensor in enumerate(run.sensors):
        values = [(p.observed_seconds, p.temperatures_c[probe]) for p in run.points
                  if p.temperatures_c[probe] is not None]
        slopes = [value for value in _window_slopes(run, probe) if value is not None]
        crossings = {str(int(threshold)): next((second for second, value in values if value >= threshold), None)
                     for threshold in THRESHOLDS}
        probes.append({
            "position": probe + 1,
            "relative_height_cm": sensor.relative_height_cm,
            "valid_samples": len(values),
            "missing_samples": len(run.points) - len(values),
            "minimum_c": min((value for _, value in values), default=None),
            "maximum_c": max((value for _, value in values), default=None),
            "peak_observed_seconds": max(values, key=lambda item: item[1])[0] if values else None,
            "maximum_heating_rate_c_per_min": max(slopes, default=None),
            "maximum_cooling_rate_c_per_min": min(slopes, default=None),
            "threshold_crossing_observed_seconds": crossings,
            "minutes_above": {str(int(t)): round(_duration_above(run, probe, t), 2) for t in THRESHOLDS},
        })
    valid_gradients = [value for value in gradients if value is not None]
    valid_spreads = [value for value in spreads if value is not None]
    return {
        "label": run.label,
        "segments": [session.session_id for session in run.sessions],
        "observed_duration_seconds": (run.points[-1].observed_seconds - run.points[0].observed_seconds
                                      if len(run.points) > 1 else 0),
        "power_gap_count": len(run.breaks),
        "warnings": list(run.warnings),
        "rapid_warming_candidates": events,
        "vertical_gradient_c_per_m": {
            "minimum": min(valid_gradients, default=None),
            "maximum": max(valid_gradients, default=None),
            "mean": statistics.fmean(valid_gradients) if valid_gradients else None,
        },
        "top_bottom_spread_c": {
            "maximum": max(valid_spreads, default=None),
            "mean": statistics.fmean(valid_spreads) if valid_spreads else None,
        },
        "probes": probes,
    }


def _clock(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    sign = "−" if seconds < 0 else ""
    seconds = abs(int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{sign}{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{sign}{minutes}:{seconds:02d}"


def _plot_html(figure: Any, div_id: str, include_js: bool = False) -> str:
    return figure.to_html(full_html=False, include_plotlyjs=True if include_js else False,
                          div_id=div_id, config={"responsive": True, "displaylogo": False,
                                                 "modeBarButtonsToRemove": ["lasso2d", "select2d"]})


def _theme_script() -> str:
    """Return browser-side Plotly theming synchronized with OS color scheme."""
    return r"""<script>
(()=>{
 const media=window.matchMedia('(prefers-color-scheme: dark)');
 function applyPlotTheme(){
  const dark=media.matches;
  const colors=dark
   ? {text:'#F5EFE7',muted:'#BDB4AA',plot:'#211E1B',grid:'#3B3631',zero:'#8F8377',hover:'#302A25'}
   : {text:'#2B2926',muted:'#706960',plot:'#FCFAF7',grid:'#E8E2DA',zero:'#968B7D',hover:'#FFFDF9'};
  document.documentElement.dataset.theme=dark?'dark':'light';
  document.querySelectorAll('.plotly-graph-div').forEach(div=>{
   const layout=div.layout||{};
   const update={
    'font.color':colors.text,'plot_bgcolor':colors.plot,'paper_bgcolor':'rgba(0,0,0,0)',
    'hoverlabel.bgcolor':colors.hover,'hoverlabel.bordercolor':colors.grid,'hoverlabel.font.color':colors.text,
    'legend.font.color':colors.text
   };
   Object.keys(layout).filter(key=>/^xaxis\d*$|^yaxis\d*$/.test(key)).forEach(key=>{
    update[key+'.gridcolor']=colors.grid;update[key+'.zerolinecolor']=colors.zero;
    update[key+'.tickfont.color']=colors.text;update[key+'.title.font.color']=colors.text;
   });
   (layout.updatemenus||[]).forEach((menu,index)=>{
    update[`updatemenus[${index}].bgcolor`]=colors.plot;
    update[`updatemenus[${index}].bordercolor`]=colors.grid;
    update[`updatemenus[${index}].font.color`]=colors.text;
   });
   (layout.shapes||[]).forEach((shape,index)=>{
    if(shape.line?.dash==='dot') update[`shapes[${index}].line.color`]=colors.muted;
   });
   Plotly.relayout(div,update);
  });
 }
 requestAnimationFrame(applyPlotTheme);
 media.addEventListener?.('change',applyPlotTheme);
 window.applySaunaPlotTheme=applyPlotTheme;
})();
</script>"""


def _base_layout(figure: Any, title: str, height: int = 430) -> None:
    figure.update_layout(
        title={"text": title, "x": 0.01, "xanchor": "left"}, height=height,
        margin={"l": 62, "r": 25, "t": 62, "b": 55},
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="#FCFAF7",
        font={"family": "Inter, ui-sans-serif, system-ui", "color": "#2B2926"},
        hovermode="x unified", legend={"orientation": "h", "y": 1.08, "x": 1, "xanchor": "right"},
    )
    figure.update_xaxes(gridcolor="#E8E2DA", zerolinecolor="#968B7D")
    figure.update_yaxes(gridcolor="#E8E2DA", zerolinecolor="#968B7D")


def _break_shapes(run: Run) -> list[dict[str, Any]]:
    return [{"type": "line", "x0": value, "x1": value, "y0": 0, "y1": 1,
             "xref": "x", "yref": "paper", "line": {"color": "#2B2926", "width": 2, "dash": "dot"}}
            for value in run.breaks]


def _narrative(run: Run, analysis: dict[str, Any]) -> list[str]:
    probes = analysis["probes"]
    peaks = [(probe["position"], probe["maximum_c"]) for probe in probes if probe["maximum_c"] is not None]
    lines = []
    if peaks:
        hottest = max(peaks, key=lambda item: item[1])
        lines.append(f"Probe {hottest[0]} recorded the run's highest temperature, {hottest[1]:.1f} °C.")
    spread = analysis["top_bottom_spread_c"]["maximum"]
    gradient = analysis["vertical_gradient_c_per_m"]["maximum"]
    if spread is not None:
        lines.append(f"The largest measured top-to-bottom difference was {spread:.1f} °C"
                     + (f", corresponding to a fitted vertical gradient of up to {gradient:.1f} °C/m." if gradient is not None else "."))
    count = len(analysis["rapid_warming_candidates"])
    lines.append(f"The stated heuristic found {count} rapid-warming candidate{'s' if count != 1 else ''}; these are observations, not identified causes.")
    missing = sum(probe["missing_samples"] for probe in probes)
    if missing:
        lines.append(f"There were {missing} missing probe readings across all channels; plots leave these values blank.")
    return lines


def export_run_html(run: Run, destination: Path) -> None:
    try:
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots
    except ImportError as error:
        raise RuntimeError("Plotly is required; install requirements-analysis.txt") from error
    if not run.points:
        raise ValueError("run has no plottable samples")
    analysis = analyze_run(run)
    xs = [point.observed_seconds for point in run.points]

    timeline = go.Figure()
    for probe, sensor in enumerate(run.sensors):
        values = [point.temperatures_c[probe] for point in run.points]
        label = f"P{probe + 1} · {abs(sensor.relative_height_cm)} cm below top"
        timeline.add_trace(go.Scatter(x=xs, y=values, mode="lines", name=label,
                                      legendgroup=f"probe-{probe}",
                                      line={"color": HEIGHT_COLORS[probe], "width": 1.5},
                                      connectgaps=False, hovertemplate="%{y:.2f} °C<extra>" + label + "</extra>"))
        timeline.add_trace(go.Scatter(x=xs, y=rolling_median(run, probe), mode="lines",
                                      name=label + " · 50 s median", visible=False, showlegend=False,
                                      legendgroup=f"probe-{probe}",
                                      line={"color": HEIGHT_COLORS[probe], "width": 3}, connectgaps=False,
                                      hovertemplate="%{y:.2f} °C<extra>50 s median</extra>"))
    _base_layout(timeline, "Eight heights over observed time", 540)
    timeline.update_xaxes(title="Observed time from initial 40 °C trigger (s); outage gaps omitted")
    timeline.update_yaxes(title="Temperature (°C)")
    timeline.update_layout(
        legend={"orientation": "h", "y": 1.08, "x": 1, "xanchor": "right", "groupclick": "togglegroup"},
        updatemenus=[{"type": "buttons", "direction": "right", "x": 0, "y": 1.18,
                      "buttons": [
                          {"label": "Raw", "method": "update",
                           "args": [{"visible": [index % 2 == 0 for index in range(16)]}]},
                          {"label": "Raw + 50 s median", "method": "update",
                           "args": [{"visible": [True] * 16}]},
                      ]}],
        shapes=_break_shapes(run) + [
        {"type": "line", "x0": min(xs), "x1": max(xs), "y0": threshold, "y1": threshold,
         "line": {"color": "#8A8178", "width": 1, "dash": "dot"}} for threshold in THRESHOLDS
    ])

    heights = [sensor.relative_height_cm for sensor in run.sensors]
    heat_heights = list(range(min(heights), max(heights) + 1, 5))
    heat_z: list[list[float | None]] = [[] for _ in heat_heights]
    for point in run.points:
        for row, height in enumerate(heat_heights):
            value = None
            if height in heights:
                value = point.temperatures_c[heights.index(height)]
                heat_z[row].append(value)
                continue
            for index in range(len(heights) - 1):
                upper, lower = heights[index], heights[index + 1]
                a, b = point.temperatures_c[index], point.temperatures_c[index + 1]
                if lower <= height <= upper and a is not None and b is not None:
                    fraction = (height - upper) / (lower - upper)
                    value = a + fraction * (b - a)
                    break
            heat_z[row].append(value)
    all_temps = [value for point in run.points for value in point.temperatures_c if value is not None]
    heatmap = go.Figure(go.Heatmap(x=xs, y=heat_heights, z=heat_z, colorscale="Turbo",
                                   zmin=min(all_temps), zmax=max(all_temps), colorbar={"title": "°C"},
                                   hovertemplate="%{x:.0f} s<br>%{y} cm<br>%{z:.1f} °C<extra></extra>"))
    _base_layout(heatmap, "Thermal field through height · vertical interpolation only", 470)
    heatmap.update_xaxes(title="Observed time (s)")
    heatmap.update_yaxes(title="Height relative to top probe (cm)")
    heatmap.update_layout(shapes=_break_shapes(run))

    peak_index = max(range(len(run.points)), key=lambda index: max(
        (value for value in run.points[index].temperatures_c if value is not None), default=-math.inf))
    profile = go.Figure(go.Scatter(x=list(run.points[peak_index].temperatures_c), y=heights,
                                   mode="lines+markers", line={"color": "#D1495B", "width": 3},
                                   marker={"size": 9}, connectgaps=False,
                                   hovertemplate="%{x:.2f} °C at %{y} cm<extra></extra>"))
    _base_layout(profile, f"Vertical profile · hover the timeline to update · {_clock(xs[peak_index])}", 430)
    profile.update_xaxes(title="Temperature (°C)")
    profile.update_yaxes(title="Height relative to top probe (cm)")

    gradients, fits, spreads = vertical_metrics(run)
    stratification = make_subplots(specs=[[{"secondary_y": True}]])
    stratification.add_trace(go.Scatter(x=xs, y=gradients, customdata=fits, name="Fitted gradient",
                                        line={"color": "#D1495B", "width": 2}, connectgaps=False), secondary_y=False)
    stratification.add_trace(go.Scatter(x=xs, y=spreads, name="Top − bottom",
                                        line={"color": "#348AA7", "width": 2}, connectgaps=False), secondary_y=True)
    _base_layout(stratification, "Vertical stratification", 420)
    stratification.update_xaxes(title="Observed time (s)")
    stratification.update_yaxes(title="Fitted gradient (°C/m)", secondary_y=False)
    stratification.update_yaxes(title="Top − bottom (°C)", secondary_y=True)
    stratification.update_layout(shapes=_break_shapes(run))

    event_rows = "".join(
        f"<tr><td>{_clock(event['observed_seconds'])}</td><td>{event['rate_c_per_min']:.2f} °C/min</td><td>{event['threshold_c_per_min']:.2f} °C/min</td></tr>"
        for event in analysis["rapid_warming_candidates"]
    ) or '<tr><td colspan="3">No candidates met the heuristic.</td></tr>'
    def minutes_above_text(probe: dict[str, Any]) -> str:
        return " / ".join(f"{probe['minutes_above'][str(int(threshold))]:.1f}" for threshold in THRESHOLDS)

    probe_rows = "".join(
        f"<tr><th>P{probe['position']}</th><td>{abs(probe['relative_height_cm'])} cm</td>"
        f"<td>{probe['maximum_c']:.1f} °C</td><td>{_clock(probe['peak_observed_seconds'])}</td>"
        f"<td>{probe['missing_samples']}</td>"
        f"<td>{' / '.join(_clock(probe['threshold_crossing_observed_seconds'][str(int(t))]) for t in THRESHOLDS)}</td>"
        f"<td>{minutes_above_text(probe)}</td></tr>"
        for probe in analysis["probes"] if probe["maximum_c"] is not None
    )
    warnings = "".join(f"<li>{html.escape(warning)}</li>" for warning in analysis["warnings"])
    layer_rows = []
    for probe in range(7):
        differences = [point.temperatures_c[probe] - point.temperatures_c[probe + 1]
                       for point in run.points
                       if point.temperatures_c[probe] is not None and point.temperatures_c[probe + 1] is not None]
        layer_rows.append(
            f"<tr><th>P{probe + 1} − P{probe + 2}</th><td>{statistics.fmean(differences):.2f} °C</td>"
            f"<td>{max(differences):.2f} °C</td><td>{len(differences)}</td></tr>" if differences else
            f"<tr><th>P{probe + 1} − P{probe + 2}</th><td colspan='3'>Insufficient data</td></tr>"
        )
    chip_values = [point.chip_temperature_c for point in run.points if point.chip_temperature_c is not None]
    degraded_count = sum(bool(point.status_flags & 8) for point in run.points)
    fallback = any(point.status_flags & 4 for point in run.points)
    session_health = "".join(
        f"<tr><th>{session.session_id}</th><td>{html.escape(session.reset_reason)}</td>"
        f"<td>{html.escape(session.initial_rtc_source)}</td><td>{'finalized' if session.finalized else 'interrupted'}</td></tr>"
        for session in run.sessions
    )
    narratives = "".join(f"<p>{html.escape(line)}</p>" for line in _narrative(run, analysis))
    metadata = [
        f"Observed duration: {_clock(analysis['observed_duration_seconds'])}",
        f"Segments: {' → '.join(map(str, analysis['segments']))}",
        f"Unknown power gaps: {analysis['power_gap_count']}",
    ]
    report_json = json.dumps({"times": xs, "temperatures": [list(point.temperatures_c) for point in run.points],
                              "heights": heights}, separators=(",", ":")).replace("</", "<\\/")
    document = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(run.label)} · Sauna thermal report</title>
<style>
:root{{--ink:#2b2926;--muted:#706960;--paper:#f5f0e8;--card:#fffdfa;--accent:#d1495b;--line:#ded5c9;color-scheme:light dark}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Inter,ui-sans-serif,system-ui,sans-serif}}
header,main,footer{{max-width:1240px;margin:auto;padding:28px}}header{{padding-top:54px}}.eyebrow{{color:var(--accent);font-weight:750;letter-spacing:.1em;text-transform:uppercase}}
h1{{font:700 clamp(2.2rem,6vw,5.2rem)/.96 Georgia,serif;margin:.2em 0}}h2{{font:650 1.5rem Georgia,serif;margin:0 0 12px}}.lead{{max-width:780px;font-size:1.17rem;color:var(--muted)}}
.meta,.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}}.pill,.card{{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:0 8px 28px #6f5b4212}}.pill{{padding:14px 18px;font-weight:650}}.card{{padding:22px;margin:20px 0;overflow:hidden}}
.split{{display:grid;grid-template-columns:1.3fr .7fr;gap:20px}}table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}}th,td{{padding:10px;border-bottom:1px solid var(--line);text-align:left}}thead th{{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.06em}}
.note{{border-left:4px solid #e9c46a;padding:10px 16px;background:#fff8dd}}.warning{{border-left-color:var(--accent);background:#fff0f1}}footer{{color:var(--muted);font-size:.9rem}}
@media(max-width:780px){{header,main,footer{{padding:20px}}.meta,.grid,.split{{grid-template-columns:1fr}}.card{{padding:12px}}}}
@media(prefers-color-scheme:dark){{:root{{--ink:#f5efe7;--muted:#bdb4aa;--paper:#171513;--card:#211e1b;--line:#3b3631}}.note{{background:#302a19}}.warning{{background:#351e22}}.js-plotly-plot .main-svg{{background:transparent!important}}.js-plotly-plot .plotly .bg{{fill:var(--card)!important}}.js-plotly-plot text{{fill:var(--ink)!important}}.js-plotly-plot .gridlayer path{{stroke:var(--line)!important}}.js-plotly-plot .zerolinelayer path{{stroke:#8f8377!important}}.js-plotly-plot .updatemenu-item-rect,.js-plotly-plot .updatemenu-header{{fill:var(--card)!important;stroke:var(--line)!important}}}}
.modebar{{background:transparent!important}}.modebar-btn path{{fill:var(--muted)!important}}.modebar-btn:hover path{{fill:var(--ink)!important}}
@media print{{body{{background:white}}.card,.pill{{box-shadow:none;break-inside:avoid}}.modebar{{display:none!important}}}}
</style></head><body><header><div class="eyebrow">Vertical thermal study</div><h1>{html.escape(run.label)}</h1>
<p class="lead">Eight temperatures at 20 cm intervals, with raw measurements kept distinct from derived views. Time across a power interruption is deliberately unknown.</p>
<div class="meta">{''.join(f'<div class="pill">{html.escape(item)}</div>' for item in metadata)}</div></header><main>
<section class="card"><h2>What stands out</h2>{narratives}</section>
<section class="card">{_plot_html(timeline, 'timeline-chart', True)}</section>
<section class="card"><p class="note">Colors between probe heights are linearly interpolated only when both adjacent probes are valid. Transparent areas are unknown.</p>{_plot_html(heatmap, 'heatmap-chart')}</section>
<div class="split"><section class="card">{_plot_html(profile, 'profile-chart')}</section><section class="card">{_plot_html(stratification, 'stratification-chart')}</section></div>
<section class="card"><h2>Probe summary</h2><div style="overflow:auto"><table><thead><tr><th>Probe</th><th>Below top</th><th>Peak</th><th>Peak time</th><th>Missing</th><th>First ≥40 / 60 / 80 / 100 °C</th><th>Minutes ≥40 / 60 / 80 / 100 °C</th></tr></thead><tbody>{probe_rows}</tbody></table></div></section>
<section class="card"><h2>Adjacent 20 cm layers</h2><table><thead><tr><th>Layer</th><th>Mean difference</th><th>Maximum difference</th><th>Paired readings</th></tr></thead><tbody>{''.join(layer_rows)}</tbody></table></section>
<section class="card"><h2>Rapid-warming candidates</h2><p class="note">Centered two-minute slopes from the upper four probes; threshold is the larger of 1 °C/min or median + 3 MAD. Candidates within five minutes are merged. This does not identify a cause.</p><table><thead><tr><th>Observed time</th><th>Composite rate</th><th>Detection threshold</th></tr></thead><tbody>{event_rows}</tbody></table></section>
<section class="card"><h2>Data integrity and logger health</h2><div class="grid"><div><strong>Degraded samples</strong><br>{degraded_count} / {len(run.points)}</div><div><strong>RTC fallback observed</strong><br>{'Yes' if fallback else 'No'}</div><div><strong>ESP32 internal temperature</strong><br>{f'{min(chip_values):.1f}–{max(chip_values):.1f} °C' if chip_values else 'Not recorded'}</div></div><table><thead><tr><th>Session</th><th>Reset</th><th>RTC at start</th><th>State</th></tr></thead><tbody>{session_health}</tbody></table>{('<ul>'+warnings+'</ul>') if warnings else '<p>No parser or chain warnings.</p>'}</section>
</main><footer>Generated from CRC-validated sauna logger data. “Observed time” excludes unknown power-off duration. Relative height uses probe 1 as 0 cm.</footer>
<script id="profile-data" type="application/json">{report_json}</script>{_theme_script()}<script>
const profileData=JSON.parse(document.getElementById('profile-data').textContent);
document.getElementById('timeline-chart').on('plotly_hover',event=>{{
 const x=event.points[0].x;let best=0,delta=Infinity;profileData.times.forEach((t,i)=>{{const d=Math.abs(t-x);if(d<delta){{best=i;delta=d}}}});
 Plotly.restyle('profile-chart',{{x:[profileData.temperatures[best]]}},[0]);
 Plotly.relayout('profile-chart',{{title:{{text:`Vertical profile · ${{Math.round(profileData.times[best])}} s`,x:.01,xanchor:'left'}}}});
}});
</script></body></html>"""
    destination.write_text(document, encoding="utf-8")


def export_comparison_html(runs: list[Run], destination: Path) -> None:
    try:
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots
    except ImportError as error:
        raise RuntimeError("Plotly is required; install requirements-analysis.txt") from error
    if len(runs) < 2:
        raise ValueError("comparison needs at least two runs")
    analyses = [analyze_run(run) for run in runs]
    overview = go.Figure()
    run_colors = ["#D1495B", "#348AA7", "#69A85F", "#8064A2", "#ED8B16", "#20A39E"]
    for probe in range(8):
        for index, run in enumerate(runs):
            overview.add_trace(go.Scatter(
                x=[point.observed_seconds for point in run.points],
                y=[point.temperatures_c[probe] for point in run.points],
                name=run.label, legendgroup=str(index), visible=probe == 0,
                line={"color": run_colors[index % len(run_colors)], "width": 2}, connectgaps=False,
                hovertemplate="%{y:.2f} °C<extra>" + run.label + "</extra>",
            ))
    buttons = []
    for probe in range(8):
        visibility = [trace_probe == probe for trace_probe in range(8) for _ in runs]
        height = abs(runs[0].sensors[probe].relative_height_cm)
        buttons.append({"label": f"P{probe + 1} · {height} cm", "method": "update",
                        "args": [{"visible": visibility}, {"title": {"text": f"Probe {probe + 1} · {height} cm below top", "x": .2}}]})
    _base_layout(overview, "Probe 1 · top reference", 560)
    overview.update_layout(title={"text": "Probe 1 · top reference", "x": .2},
                           margin={"l": 62, "r": 25, "t": 88, "b": 55},
                           updatemenus=[{"buttons": buttons, "direction": "down", "x": 0, "y": 1.16,
                                        "showactive": True, "active": 0}])
    overview.update_xaxes(title="Observed time from 40 °C trigger (s); outage gaps omitted")
    overview.update_yaxes(title="Temperature (°C)")

    heatmaps = make_subplots(rows=len(runs), cols=1, shared_xaxes=False,
                             subplot_titles=tuple(run.label for run in runs), vertical_spacing=.08)
    shared_values = [value for run in runs for point in run.points for value in point.temperatures_c if value is not None]
    shared_min, shared_max = min(shared_values), max(shared_values)
    for row, run in enumerate(runs, 1):
        heatmaps.add_trace(go.Heatmap(
            x=[point.observed_seconds for point in run.points],
            y=[sensor.relative_height_cm for sensor in run.sensors],
            z=[[point.temperatures_c[probe] for point in run.points] for probe in range(8)],
            colorscale="Turbo", zmin=shared_min, zmax=shared_max,
            coloraxis="coloraxis", hovertemplate="%{x:.0f} s<br>%{y} cm<br>%{z:.1f} °C<extra></extra>"),
            row=row, col=1)
        heatmaps.update_yaxes(title="Relative cm", row=row, col=1)
        heatmaps.update_xaxes(title="Observed seconds" if row == len(runs) else None, row=row, col=1)
    _base_layout(heatmaps, "Thermal fields on one temperature scale", max(480, 275 * len(runs)))
    heatmaps.update_layout(coloraxis={"colorscale": "Turbo", "cmin": shared_min, "cmax": shared_max,
                                      "colorbar": {"title": "°C"}})
    rows = []
    for run, analysis in zip(runs, analyses):
        peak = max((probe["maximum_c"] for probe in analysis["probes"] if probe["maximum_c"] is not None), default=None)
        spread = analysis["top_bottom_spread_c"]["maximum"]
        rows.append(f"<tr><th>{html.escape(run.label)}</th><td>{_clock(analysis['observed_duration_seconds'])}</td>"
                    f"<td>{f'{peak:.1f} °C' if peak is not None else '—'}</td><td>{f'{spread:.1f} °C' if spread is not None else '—'}</td>"
                    f"<td>{len(analysis['rapid_warming_candidates'])}</td><td>{sum(p['missing_samples'] for p in analysis['probes'])}</td></tr>")
    document = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sauna run comparison</title><style>:root{{--ink:#2b2926;--paper:#f5f0e8;--card:#fffdfa;--line:#ded5c9;--muted:#706960;color-scheme:light dark}}body{{margin:auto;max-width:1240px;padding:32px;background:var(--paper);color:var(--ink);font:16px/1.5 Inter,system-ui}}h1{{font:700 clamp(2.4rem,6vw,5rem)/1 Georgia,serif}}section{{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;margin:20px 0;overflow:auto}}table{{width:100%;border-collapse:collapse}}th,td{{padding:12px;border-bottom:1px solid var(--line);text-align:left}}.modebar{{background:transparent!important}}.modebar-btn path{{fill:var(--muted)!important}}.modebar-btn:hover path{{fill:var(--ink)!important}}@media(prefers-color-scheme:dark){{:root{{--ink:#f5efe7;--paper:#171513;--card:#211e1b;--line:#3b3631;--muted:#bdb4aa}}.js-plotly-plot .main-svg{{background:transparent!important}}.js-plotly-plot .plotly .bg{{fill:var(--card)!important}}.js-plotly-plot text{{fill:var(--ink)!important}}.js-plotly-plot .gridlayer path{{stroke:var(--line)!important}}.js-plotly-plot .zerolinelayer path{{stroke:#8f8377!important}}.js-plotly-plot .updatemenu-item-rect,.js-plotly-plot .updatemenu-header{{fill:var(--card)!important;stroke:var(--line)!important}}}}@media(max-width:700px){{body{{padding:14px}}section{{padding:10px}}}}</style></head>
<body><div style="color:#d1495b;font-weight:750;text-transform:uppercase;letter-spacing:.1em">Thermal comparison</div><h1>{len(runs)} sauna runs</h1><p>Root segments are aligned at their firmware 40 °C trigger. Power-off duration is omitted and marked as an unknown gap in individual reports.</p>
<section>{_plot_html(overview, 'comparison-chart', True)}</section><section>{_plot_html(heatmaps, 'comparison-heatmaps')}</section><section><h2>Comparable outcomes</h2><table><thead><tr><th>Run</th><th>Observed duration</th><th>Overall peak</th><th>Max top−bottom</th><th>Rapid candidates</th><th>Missing values</th></tr></thead><tbody>{''.join(rows)}</tbody></table></section>
<section><h2>Interpretation limits</h2><p>These comparisons describe measured temperature at relative heights. They do not include humidity, heater state, door openings, occupancy, or the unknown duration of power interruptions.</p></section>{_theme_script()}</body></html>"""
    destination.write_text(document, encoding="utf-8")
