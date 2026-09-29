import { createChart, CandlestickSeries, AreaSeries, createSeriesMarkers, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { nyTime } from '../format.js';

// TradingView Lightweight Charts™ wrappers themed for the floor.

const THEME = {
  bg: '#11151d',
  text: '#9aa3b2',
  grid: 'rgba(255,255,255,0.05)',
  border: 'rgba(255,255,255,0.1)',
  up: '#089981',
  down: '#f23645',
};

function baseOptions(container, extra = {}) {
  return {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: ColorType.Solid, color: THEME.bg },
      textColor: THEME.text,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: 11,
      attributionLogo: true,
    },
    grid: { vertLines: { color: THEME.grid }, horzLines: { color: THEME.grid } },
    rightPriceScale: { borderColor: THEME.border },
    timeScale: {
      borderColor: THEME.border,
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (t) => nyTime(t * 1000),
    },
    localization: { timeFormatter: (t) => `${nyTime(t * 1000)} ET` },
    crosshair: { mode: CrosshairMode.Normal },
    ...extra,
  };
}

function autoResize(chart, container) {
  const ro = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
  ro.observe(container);
  return () => ro.disconnect();
}

export function candleChart(container, decimals = 2) {
  const chart = createChart(container, baseOptions(container));
  const minMove = Number((10 ** -decimals).toFixed(decimals));
  const series = chart.addSeries(CandlestickSeries, {
    upColor: THEME.up,
    downColor: THEME.down,
    borderVisible: false,
    wickUpColor: THEME.up,
    wickDownColor: THEME.down,
    priceFormat: { type: 'price', precision: decimals, minMove },
  });
  const markers = createSeriesMarkers(series, []);
  const stopResize = autoResize(chart, container);
  let lines = [];
  let lastTime = 0;
  return {
    chart,
    setData(bars) {
      series.setData(bars);
      lastTime = bars.length ? bars[bars.length - 1].time : 0;
      chart.timeScale().scrollToRealTime();
    },
    update(bar) {
      if (!bar || bar.time < lastTime) return;
      series.update(bar);
      lastTime = bar.time;
    },
    setLines(defs) {
      for (const l of lines) series.removePriceLine(l);
      lines = defs.filter((d) => Number.isFinite(d.price)).map((d) =>
        series.createPriceLine({
          price: d.price,
          color: d.color,
          lineWidth: d.width ?? 1,
          lineStyle: d.dashed === false ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title: d.title,
        }),
      );
    },
    setMarkers(list) {
      markers.setMarkers(list);
    },
    destroy() {
      stopResize();
      chart.remove();
    },
  };
}

export function equityChart(container) {
  const chart = createChart(container, baseOptions(container, {
    rightPriceScale: { borderColor: THEME.border, scaleMargins: { top: 0.12, bottom: 0.08 } },
  }));
  const series = chart.addSeries(AreaSeries, {
    lineColor: '#3987e5',
    lineWidth: 2,
    topColor: 'rgba(57, 135, 229, 0.28)',
    bottomColor: 'rgba(57, 135, 229, 0.02)',
    priceFormat: { type: 'custom', formatter: (v) => `$${(v / 1e6).toFixed(3)}M`, minMove: 1 },
    lastValueVisible: true,
    priceLineVisible: false,
  });
  const stopResize = autoResize(chart, container);
  let lastTime = 0;
  let baseline = null;
  return {
    setData(points, start) {
      series.setData(points);
      lastTime = points.length ? points[points.length - 1].time : 0;
      if (baseline) series.removePriceLine(baseline);
      if (Number.isFinite(start)) {
        baseline = series.createPriceLine({ price: start, color: 'rgba(255,255,255,0.35)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Start' });
      }
      chart.timeScale().fitContent();
    },
    update(point) {
      if (point.time <= lastTime) return;
      series.update(point);
      lastTime = point.time;
    },
    destroy() {
      stopResize();
      chart.remove();
    },
  };
}
