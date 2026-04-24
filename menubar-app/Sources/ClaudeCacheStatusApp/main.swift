import AppKit
import Foundation
import Charts
import SwiftUI

private let defaultProxyStatusURL = URL(string: "http://127.0.0.1:3456/__status")!
private let proxyStatusURL: URL = {
    guard let value = ProcessInfo.processInfo.environment["CLAUDE_CACHE_STATUS_URL"] else {
        return defaultProxyStatusURL
    }
    return URL(string: value) ?? defaultProxyStatusURL
}()
private let proxyErrorLogURL = URL(fileURLWithPath: NSHomeDirectory())
    .appendingPathComponent("Library/Logs/claude-openrouter-ttl-1h.error.log")
private let proxyOutLogURL = URL(fileURLWithPath: NSHomeDirectory())
    .appendingPathComponent("Library/Logs/claude-openrouter-ttl-1h.log")

struct MonitorSnapshot: Decodable {
    struct Service: Decodable {
        let name: String
        let version: Int
        let pid: Int
        let healthy: Bool
        let started_at: String
        let uptime_seconds: Int
        let last_updated_at: String
        let listen_host: String
        let listen_port: Int
        let upstream_base_url: String
        let cache_ttl_seconds: Int
        let total_requests_served: Int
        let total_generations_observed: Int
        let total_input_tokens: Int
        let total_output_tokens: Int
        let total_cache_creation_input_tokens: Int
        let total_cache_read_input_tokens: Int
        let total_tokens: Int
        let total_cost_usd: Double
        let total_cache_discount_usd: Double
        let total_upstream_inference_cost_usd: Double
        let active_session_count: Int
        let tracked_session_count: Int
        let active_cache_write_count: Int
        let tracked_cache_write_count: Int
        let cache_write_chart_window_seconds: Int
        let cache_write_chart_bucket_seconds: Int
        let status_endpoint: String
    }

    struct CacheWrite: Decodable, Identifiable {
        let id: String
        let generation_id: String?
        let session_id: String
        let source: String
        let created_at: String?
        let expires_at: String?
        let remaining_seconds: Int?
        let is_active: Bool
        let latest_model: String?
        let latest_provider: String?
        let input_tokens: Int
        let output_tokens: Int
        let cache_creation_input_tokens: Int
        let cache_read_input_tokens: Int
        let total_tokens: Int
        let total_cost_usd: Double
        let request_id: String?

        var expiryDate: Date? {
            parseISODate(expires_at)
        }
    }

    struct CacheWriteBucket: Decodable, Identifiable {
        let starts_at: String
        let ends_at: String
        let cache_creation_input_tokens: Int
        let write_count: Int
        let active_write_count: Int
        let total_cost_usd: Double

        var id: String {
            starts_at
        }

        var startDate: Date {
            parseISODate(starts_at) ?? .distantPast
        }
    }

    struct Session: Decodable, Identifiable {
        let id: String
        let source: String
        let created_at: String
        let last_seen_at: String
        let first_cache_at: String?
        let first_cache_expires_at: String?
        let first_cache_remaining_seconds: Int?
        let is_active: Bool
        let latest_model: String?
        let latest_provider: String?
        let request_count: Int
        let generation_count: Int
        let total_input_tokens: Int
        let total_output_tokens: Int
        let total_cache_creation_input_tokens: Int
        let total_cache_read_input_tokens: Int
        let total_tokens: Int
        let total_cost_usd: Double
        let total_cache_discount_usd: Double
        let total_upstream_inference_cost_usd: Double
        let last_generation_id: String?
        let last_request_id: String?

        var firstCacheExpiryDate: Date? {
            parseISODate(first_cache_expires_at)
        }

        var lastSeenDate: Date? {
            parseISODate(last_seen_at)
        }
    }

    let service: Service
    let cache_write_buckets_24h: [CacheWriteBucket]
    let cache_writes: [CacheWrite]
    let sessions: [Session]
}

func parseISODate(_ value: String?) -> Date? {
    guard let value else {
        return nil
    }
    let fractionalFormatter = ISO8601DateFormatter()
    fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractionalFormatter.date(from: value) {
        return date
    }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
}

func formatInteger(_ value: Int) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
}

func formatUSD(_ value: Double) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.maximumFractionDigits = 6
    formatter.minimumFractionDigits = 2
    return formatter.string(from: NSNumber(value: value)) ?? String(format: "$%.6f", value)
}

func formatCompactInteger(_ value: Int) -> String {
    if value >= 1_000_000 {
        return String(format: "%.1fM", Double(value) / 1_000_000)
    }
    if value >= 1_000 {
        return "\(value / 1_000)k"
    }
    return "\(value)"
}

func formatRemainingTime(expiryDate: Date?, now: Date) -> String {
    guard let expiryDate else {
        return "unknown"
    }

    let seconds = max(0, Int(expiryDate.timeIntervalSince(now)))
    let hours = seconds / 3600
    let minutes = (seconds % 3600) / 60
    let remainingSeconds = seconds % 60

    if hours > 0 {
        return String(format: "%02dh %02dm %02ds", hours, minutes, remainingSeconds)
    }
    return String(format: "%02dm %02ds", minutes, remainingSeconds)
}

func relativeTimestamp(_ value: String?) -> String {
    guard let date = parseISODate(value) else {
        return "unknown"
    }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter.localizedString(for: date, relativeTo: Date())
}

@MainActor
final class MonitorStore: ObservableObject {
    @Published var snapshot: MonitorSnapshot?
    @Published var lastError: String?
    @Published var now = Date()
    @Published var isRefreshing = false

    private var refreshTask: Task<Void, Never>?
    private var clockTask: Task<Void, Never>?

    init() {
        refreshTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }

        clockTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                now = Date()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    deinit {
        refreshTask?.cancel()
        clockTask?.cancel()
    }

    func refresh() async {
        if isRefreshing {
            return
        }

        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let (data, response) = try await URLSession.shared.data(from: proxyStatusURL)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                lastError = "proxy returned an unexpected response"
                return
            }

            let decoded = try JSONDecoder().decode(MonitorSnapshot.self, from: data)
            snapshot = decoded
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    var activeCacheWrites: [MonitorSnapshot.CacheWrite] {
        snapshot?.cache_writes.filter(\.is_active) ?? []
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

struct StatusBarLabel: View {
    let snapshot: MonitorSnapshot?
    let lastError: String?

    private var activeCount: Int {
        snapshot?.service.active_cache_write_count ?? 0
    }

    private var countLabel: String {
        activeCount > 99 ? "99+" : "\(activeCount)"
    }

    private var iconName: String {
        if snapshot != nil {
            return activeCount > 0 ? "square.stack.3d.up.fill" : "square.stack.3d.up"
        }
        if lastError == nil {
            return "arrow.triangle.2.circlepath"
        }
        return "xmark.circle.fill"
    }

    private var statusDotColor: Color {
        if snapshot != nil {
            return activeCount > 0 ? .green : .secondary
        }
        return lastError == nil ? .orange : .red
    }

    var body: some View {
        HStack(spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: iconName)
                    .font(.system(size: 14, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)

                Circle()
                    .fill(statusDotColor)
                    .frame(width: 6, height: 6)
                    .overlay(
                        Circle()
                            .stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1)
                    )
                    .offset(x: 2, y: 1)
            }

            if snapshot != nil {
                Text(countLabel)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(Capsule())
            } else if lastError == nil {
                Text("…")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
            }
        }
        .help("Claude cache monitor")
    }
}

struct MetricPill: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.body, design: .monospaced))
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct CacheWriteTrendChart: View {
    let buckets: [MonitorSnapshot.CacheWriteBucket]

    private var totalCacheWrite: Int {
        buckets.reduce(0) { $0 + $1.cache_creation_input_tokens }
    }

    private var totalWrites: Int {
        buckets.reduce(0) { $0 + $1.write_count }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Cache Write Trend")
                        .font(.headline)
                    Text("past 24 hours by hour")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 3) {
                    Text(formatInteger(totalCacheWrite))
                        .font(.system(.body, design: .monospaced))
                    Text("\(formatInteger(totalWrites)) writes")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Chart(buckets) { bucket in
                AreaMark(
                    x: .value("Time", bucket.startDate),
                    y: .value("Cache Write", bucket.cache_creation_input_tokens)
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [
                            Color.accentColor.opacity(0.35),
                            Color.accentColor.opacity(0.04),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .interpolationMethod(.catmullRom)

                LineMark(
                    x: .value("Time", bucket.startDate),
                    y: .value("Cache Write", bucket.cache_creation_input_tokens)
                )
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.catmullRom)

                if bucket.cache_creation_input_tokens > 0 {
                    PointMark(
                        x: .value("Time", bucket.startDate),
                        y: .value("Cache Write", bucket.cache_creation_input_tokens)
                    )
                    .foregroundStyle(Color.accentColor)
                    .symbolSize(32)
                }
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .hour, count: 6)) {
                    AxisGridLine()
                        .foregroundStyle(Color(nsColor: .separatorColor).opacity(0.45))
                    AxisTick()
                    AxisValueLabel(format: .dateTime.hour(.twoDigits(amPM: .omitted)))
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { value in
                    AxisGridLine()
                        .foregroundStyle(Color(nsColor: .separatorColor).opacity(0.35))
                    AxisTick()
                    if let intValue = value.as(Int.self) {
                        AxisValueLabel(formatCompactInteger(intValue))
                    }
                }
            }
            .chartLegend(.hidden)
            .frame(height: 170)
        }
        .padding(12)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
        )
    }
}

struct CacheWriteCardView: View {
    let cacheWrite: MonitorSnapshot.CacheWrite
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(cacheWrite.latest_model ?? "unknown model")
                        .font(.headline)
                    Text(cacheWrite.generation_id ?? cacheWrite.id)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Text("session: \(cacheWrite.session_id)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(cacheWrite.generation_id ?? cacheWrite.id, forType: .string)
                }
                .buttonStyle(.borderless)
            }

            HStack(spacing: 10) {
                MetricPill(
                    title: "TTL Remaining",
                    value: formatRemainingTime(expiryDate: cacheWrite.expiryDate, now: now)
                )
                MetricPill(
                    title: "Cache Write",
                    value: formatInteger(cacheWrite.cache_creation_input_tokens)
                )
                MetricPill(
                    title: "Cost",
                    value: formatUSD(cacheWrite.total_cost_usd)
                )
            }

            HStack(spacing: 10) {
                MetricPill(
                    title: "Read",
                    value: formatInteger(cacheWrite.input_tokens)
                )
                MetricPill(
                    title: "Write",
                    value: formatInteger(cacheWrite.output_tokens)
                )
                MetricPill(
                    title: "Cache Read",
                    value: formatInteger(cacheWrite.cache_read_input_tokens)
                )
            }

            if let provider = cacheWrite.latest_provider {
                Text("provider: \(provider)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text("written \(relativeTimestamp(cacheWrite.created_at))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let requestId = cacheWrite.request_id {
                    Text(requestId)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
        )
    }
}

struct RootView: View {
    @ObservedObject var store: MonitorStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Claude Cache Monitor")
                        .font(.headline)
                    if let snapshot = store.snapshot {
                        Text(snapshot.service.healthy ? "proxy online" : "proxy offline")
                            .foregroundStyle(snapshot.service.healthy ? .green : .red)
                    } else {
                        Text("waiting for proxy")
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                Button("Refresh") {
                    Task { await store.refresh() }
                }
                .disabled(store.isRefreshing)
            }

            if let snapshot = store.snapshot {
                HStack(spacing: 10) {
                    MetricPill(
                        title: "Active Cache Writes",
                        value: formatInteger(snapshot.service.active_cache_write_count)
                    )
                    MetricPill(
                        title: "Total Tokens",
                        value: formatInteger(snapshot.service.total_tokens)
                    )
                    MetricPill(
                        title: "Total Cost",
                        value: formatUSD(snapshot.service.total_cost_usd)
                    )
                }

                HStack(spacing: 10) {
                    MetricPill(
                        title: "Read",
                        value: formatInteger(snapshot.service.total_input_tokens)
                    )
                    MetricPill(
                        title: "Write",
                        value: formatInteger(snapshot.service.total_output_tokens)
                    )
                    MetricPill(
                        title: "Cache Read",
                        value: formatInteger(snapshot.service.total_cache_read_input_tokens)
                    )
                    MetricPill(
                        title: "Cache Write",
                        value: formatInteger(snapshot.service.total_cache_creation_input_tokens)
                    )
                }

                CacheWriteTrendChart(buckets: snapshot.cache_write_buckets_24h)

                Text("proxy: \(snapshot.service.listen_host):\(snapshot.service.listen_port)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("last updated \(relativeTimestamp(snapshot.service.last_updated_at))")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Divider()

                if store.activeCacheWrites.isEmpty {
                    Text("No active cache writes in the current TTL window.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(store.activeCacheWrites) { cacheWrite in
                                CacheWriteCardView(cacheWrite: cacheWrite, now: store.now)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .frame(width: 520, height: 300)
                }
            } else if let lastError = store.lastError {
                Text("Proxy unreachable: \(lastError)")
                    .foregroundStyle(.red)
                    .frame(width: 420, alignment: .leading)
            } else {
                ProgressView()
                    .controlSize(.small)
            }

            Divider()

            HStack {
                Button("Open Error Log") {
                    NSWorkspace.shared.open(proxyErrorLogURL)
                }
                Button("Open Service Log") {
                    NSWorkspace.shared.open(proxyOutLogURL)
                }
                Spacer()
                Button("Quit") {
                    NSApp.terminate(nil)
                }
            }
        }
        .padding(16)
        .frame(width: 560)
    }
}

@main
struct ClaudeCacheStatusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = MonitorStore()

    var body: some Scene {
        MenuBarExtra {
            RootView(store: store)
        } label: {
            StatusBarLabel(snapshot: store.snapshot, lastError: store.lastError)
        }
        .menuBarExtraStyle(.window)

        Settings {
            EmptyView()
        }
    }
}
