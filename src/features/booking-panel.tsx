import { Building2, ExternalLink, Plane, Ticket } from "lucide-react";

export type BookingPanelProps = {
  destination: string;
  startDate: string;
  days: number;
  travelers: number;
  onOpenRail: () => void;
  onOpenFlight: () => void;
  onOpenHotel: () => void;
  onOpenHotelMap: () => void;
};

function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function BookingPanel({
  destination,
  startDate,
  days,
  travelers,
  onOpenRail,
  onOpenFlight,
  onOpenHotel,
  onOpenHotelMap,
}: BookingPanelProps) {
  return (
    <section className="booking-panel" aria-label="预订入口">
      <div className="booking-panel-head">
        <div>
          <div className="eyebrow">BOOKING CHECKLIST</div>
          <h3>把这趟行程订下来</h3>
          <p>
            {destination} · {dateLabel(startDate)}出发 · {days}天 · {travelers}人
          </p>
        </div>
        <span className="booking-local-badge">本地规划 · 外部下单</span>
      </div>
      <div className="booking-grid">
        <button type="button" className="booking-action booking-action--rail" onClick={onOpenRail}>
          <Ticket size={18} />
          <span><strong>火车票</strong><small>打开 12306 官方入口</small></span>
          <ExternalLink size={14} />
        </button>
        <button type="button" className="booking-action booking-action--flight" onClick={onOpenFlight}>
          <Plane size={18} />
          <span><strong>机票</strong><small>打开机票搜索入口</small></span>
          <ExternalLink size={14} />
        </button>
        <button type="button" className="booking-action booking-action--hotel" onClick={onOpenHotel}>
          <Building2 size={18} />
          <span><strong>订酒店</strong><small>打开酒店预订入口</small></span>
          <ExternalLink size={14} />
        </button>
        <button type="button" className="booking-action booking-action--map" onClick={onOpenHotelMap}>
          <Building2 size={18} />
          <span><strong>附近住宿</strong><small>优先打开本机地图 App</small></span>
          <ExternalLink size={14} />
        </button>
      </div>
      <p className="booking-footnote">只负责打开官方或搜索入口，不会自动下单、付款或保存订单信息；请在外部页面核对日期、证件、价格与退改规则。</p>
    </section>
  );
}
