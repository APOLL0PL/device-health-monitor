// DHM Agent w Go — prototyp.
// Zbiera metryki (CPU/RAM/dysk/temp/uptime/sieć) i raportuje do serwera DHM.
// Tylko stdlib, zero zależności → statyczny binarek (go build).
//
// Linux-owy odczyt metryk z /proc i /sys. Windows: do dopisania osobno.
//
// Zmienne: SERVER_URL, DEVICE_NAME, DEVICE_TYPE, REPORT_INTERVAL, REGISTER_TOKEN
// Flagi:   -once (jeden raport i wyjście — do testów), -register-only
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

type deviceInfo struct {
	Name string
	Type string
	IP   string
	Mac  string
}

type metrics struct {
	CPUPercent     float64  `json:"cpu_percent"`
	RAMUsedMB      int64    `json:"ram_used_mb"`
	RAMCacheMB     int64    `json:"ram_cache_mb"`
	RAMTotalMB     int64    `json:"ram_total_mb"`
	DiskUsedGB     float64  `json:"disk_used_gb"`
	DiskTotalGB    float64  `json:"disk_total_gb"`
	DiskSysUsedGB  float64  `json:"disk_sys_used_gb"`
	DiskSysTotalGB float64  `json:"disk_sys_total_gb"`
	TemperatureC   *float64 `json:"temperature_c"`
	UptimeSeconds  int64    `json:"uptime_seconds"`
	NetInBytes     int64    `json:"net_in_bytes"`
	NetOutBytes    int64    `json:"net_out_bytes"`
}

// ---------------------------------------------------------------- konfig ---

var (
	serverURL   = os.Getenv("SERVER_URL")
	deviceType  = os.Getenv("DEVICE_TYPE")
	deviceName  = os.Getenv("DEVICE_NAME")
	regToken    = os.Getenv("REGISTER_TOKEN")
	reportIntvS = os.Getenv("REPORT_INTERVAL")
)

func main() {
	once := flag.Bool("once", false, "jeden raport i wyjście (testy)")
	registerOnly := flag.Bool("register-only", false, "tylko rejestracja i wyjście")
	flag.Parse()

	if serverURL == "" {
		serverURL = "http://localhost:4000"
	}
	if deviceType == "" {
		deviceType = "server"
	}
	if deviceName == "" {
		deviceName, _ = os.Hostname()
	}
	interval := 60
	if deviceType == "phone" || deviceType == "android" {
		interval = 300
	}
	if reportIntvS != "" {
		fmt.Sscanf(reportIntvS, "%d", &interval)
		if interval < 10 {
			interval = 60
		}
	}

	keyPath := apiKeyPath()
	di := deviceInfo{Name: deviceName, Type: deviceType}

	apiKey, err := os.ReadFile(keyPath)
	if err == nil && strings.TrimSpace(string(apiKey)) != "" {
		apiKey = []byte(strings.TrimSpace(string(apiKey)))
	} else {
		apiKey = nil
	}

	if string(apiKey) == "" {
		apiKey, err = register(di, regToken)
		if err != nil {
			fatal("rejestracja nieudana: %v", err)
		}
		os.WriteFile(keyPath, apiKey, 0600)
		fmt.Printf("Zarejestrowano. Klucz zapisany w %s\n", keyPath)
		if *registerOnly {
			return
		}
	}

	report(di, string(apiKey))
	if *once {
		return
	}

	fmt.Printf("DHM Agent (Go) — raportuje do %s co %ds\n", serverURL, interval)
	t := time.NewTicker(time.Duration(interval) * time.Second)
	for range t.C {
		report(di, string(apiKey))
	}
}

// ------------------------------------------------------------------ api -----

func apiKeyPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ".api_key"
	}
	return filepath.Join(filepath.Dir(exe), ".api_key")
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[ERROR] "+format+"\n", a...)
	os.Exit(1)
}

func register(di deviceInfo, token string) ([]byte, error) {
	// IP/MAC liczone tu, nie w main - rejestracja idzie przed pierwszym raportem
	di.IP = getLocalIP()
	di.Mac = getMac()
	payload, _ := json.Marshal(map[string]any{
		"name":           di.Name,
		"ip":             di.IP,
		"type":           di.Type,
		"os_name":        runtime.GOOS,
		"mac":            di.Mac,
		"register_token": token,
	})
	res, err := http.Post(serverURL+"/api/agent/register", "application/json", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("serwer zwrócił %d: %s", res.StatusCode, string(b))
	}
	var out struct {
		APIKey string `json:"api_key"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.APIKey == "" {
		return nil, errors.New("brak api_key w odpowiedzi")
	}
	return []byte(out.APIKey), nil
}

func report(di deviceInfo, apiKey string) {
	di.IP = getLocalIP()
	di.Mac = getMac()
	m, err := getMetrics()
	if err != nil {
		fmt.Printf("Raport nieudany: %v\n", err)
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"cpu_percent":       m.CPUPercent,
		"ram_used_mb":       m.RAMUsedMB,
		"ram_cache_mb":      m.RAMCacheMB,
		"ram_total_mb":      m.RAMTotalMB,
		"disk_used_gb":      m.DiskUsedGB,
		"disk_total_gb":     m.DiskTotalGB,
		"disk_sys_used_gb":  m.DiskSysUsedGB,
		"disk_sys_total_gb": m.DiskSysTotalGB,
		"temperature_c":     m.TemperatureC,
		"uptime_seconds":    m.UptimeSeconds,
		"net_in_bytes":      m.NetInBytes,
		"net_out_bytes":     m.NetOutBytes,
		"ip":                di.IP,
		"mac":               di.Mac,
	})
	req, _ := http.NewRequest("POST", serverURL+"/api/agent/report", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", apiKey)

	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		fmt.Printf("Raport nieudany: %v\n", err)
		return
	}
	res.Body.Close()

	switch res.StatusCode {
	case 200:
		fmt.Printf("Raport: CPU %.1f%% | RAM %d/%dMB | Dysk %.1f/%.1fGB | Temp %s | Sieć ↓ %dB ↑ %dB\n",
			m.CPUPercent, m.RAMUsedMB, m.RAMTotalMB, m.DiskUsedGB, m.DiskTotalGB,
			fmtTemp(m.TemperatureC), m.NetInBytes, m.NetOutBytes)
	case 401, 403:
		fmt.Println("Klucz odrzucony, rejestruję ponownie...")
		if key, err := register(di, regToken); err == nil {
			os.WriteFile(apiKeyPath(), key, 0600)
		}
	default:
		fmt.Printf("Raport: serwer zwrócił %d\n", res.StatusCode)
	}
}

func fmtTemp(t *float64) string {
	if t == nil {
		return "n/a"
	}
	return fmt.Sprintf("%.0fC", *t)
}

// ------------------------------------------------------------- interfejsy ---

func isVirtualIface(name string) bool {
	return strings.HasPrefix(name, "br-") ||
		strings.HasPrefix(name, "veth") ||
		strings.HasPrefix(name, "docker") ||
		strings.HasPrefix(name, "virbr") ||
		strings.HasPrefix(name, "zbr") ||
		strings.HasPrefix(name, "tun") ||
		strings.HasPrefix(name, "vpn") ||
		strings.HasPrefix(name, "tap")
}

func getLocalIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "127.0.0.1"
	}
	var lan, fallback string
	for _, ifc := range ifaces {
		if isVirtualIface(ifc.Name) {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.To4() == nil {
				continue
			}
			ip := ipnet.IP.To4().String()
			if ip == "127.0.0.1" {
				continue
			}
			if strings.HasPrefix(ip, "192.168.") {
				return ip
			}
			if strings.HasPrefix(ip, "10.") && lan == "" {
				lan = ip
			}
			if fallback == "" {
				fallback = ip
			}
		}
	}
	if lan != "" {
		return lan
	}
	return fallback
}

func getMac() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, ifc := range ifaces {
		if isVirtualIface(ifc.Name) {
			continue
		}
		// tylko interfejs z adresem IPv4, nie loopback
		if ifc.Flags&net.FlagLoopback != 0 || len(ifc.HardwareAddr) == 0 {
			continue
		}
		if addrs, _ := ifc.Addrs(); len(addrs) > 0 {
			return ifc.HardwareAddr.String()
		}
	}
	return ""
}

// ---------------------------------------------------------------- metryki ---

// CPU: delta /proc/stat w oknie ~500ms
func getCPUPct() (float64, error) {
	t1, i1, err := readProcStat()
	if err != nil {
		return 0, err
	}
	time.Sleep(500 * time.Millisecond)
	t2, i2, err := readProcStat()
	if err != nil {
		return 0, err
	}
	dTotal := t2 - t1
	dIdle := i2 - i1
	if dTotal <= 0 {
		return 0, nil
	}
	return (1 - float64(dIdle)/float64(dTotal)) * 100, nil
}

func readProcStat() (total, idle uint64, err error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line[4:])
		if len(fields) < 4 {
			return
		}
		for _, v := range fields {
			n := uint64(0)
			fmt.Sscanf(v, "%d", &n)
			total += n
		}
		idle = 0
		if len(fields) > 3 {
			fmt.Sscanf(fields[3], "%d", &idle) // idle
		}
		return
	}
	return
}

func getRAM() (usedMB, cacheMB, totalMB int64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return
	}
	defer f.Close()
	var memTotal, memAvail, buffers, cached uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var v uint64
		var k string
		if _, err := fmt.Sscanf(sc.Text(), "%s %d", &k, &v); err != nil {
			continue
		}
		switch k {
		case "MemTotal:":
			memTotal = v
		case "MemAvailable:":
			memAvail = v
		case "Buffers:":
			buffers = v
		case "Cached:":
			cached = v
		}
	}
	usedMB = int64((memTotal - memAvail) / 1024)
	cacheMB = int64((buffers + cached) / 1024)
	totalMB = int64(memTotal / 1024)
	return
}

type diskUsage struct {
	usedGB, totalGB float64
}

func getDisk(path string) (diskUsage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return diskUsage{}, err
	}
	bsize := uint64(st.Bsize)
	total := st.Blocks * bsize
	free := st.Bfree * bsize
	return diskUsage{
		totalGB: float64(total) / 1024 / 1024 / 1024,
		usedGB:  float64(total-free) / 1024 / 1024 / 1024,
	}, nil
}

// Temperatura: pierwsza lepsza wartość >0 z /sys/class/hwmon (najpierw core/pkg)
func getTemperature() *float64 {
	files, err := filepath.Glob("/sys/class/hwmon/hwmon*/temp*_input")
	if err != nil {
		return nil
	}
	best := 0.0
	bestScore := -1
	for _, f := range files {
		name := strings.TrimSuffix(f, "_input") + "_label"
		score := 0
		if b, err := os.ReadFile(name); err == nil {
			l := strings.ToLower(string(b))
			if strings.Contains(l, "core") || strings.Contains(l, "pkg") || strings.Contains(l, "tctl") {
				score = 2
			} else if strings.Contains(l, "cpu") {
				score = 1
			}
		}
		if score < bestScore {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var milli int
		if _, err := fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &milli); err != nil {
			continue
		}
		c := float64(milli) / 1000
		if c <= 0 || c > 200 {
			continue
		}
		best = c
		bestScore = score
	}
	if best == 0 {
		return nil
	}
	return &best
}

func getUptime() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	var up float64
	fmt.Sscanf(strings.TrimSpace(string(b)), "%f", &up)
	return int64(up)
}

// Suma liczników rx/tx (cumulative — serwer liczy z nich prędkość)
func getNetTotals() (rx, tx int64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.Contains(line, ":") {
			continue
		}
		name := strings.TrimSpace(strings.Split(line, ":")[0])
		if isVirtualIface(name) || name == "lo" {
			continue
		}
		fields := strings.Fields(strings.SplitN(line, ":", 2)[1])
		if len(fields) < 9 {
			continue
		}
		var r, t uint64
		fmt.Sscanf(fields[0], "%d", &r)
		fmt.Sscanf(fields[8], "%d", &t)
		rx += int64(r)
		tx += int64(t)
	}
	return
}

func getMetrics() (metrics, error) {
	cpu, err := getCPUPct()
	if err != nil {
		return metrics{}, err
	}
	usedMB, cacheMB, totalMB := getRAM()
	mainDisk, err := getDisk("/")
	if err != nil {
		return metrics{}, err
	}
	homeDisk, _ := getDisk("/home")
	totalUsed := mainDisk.usedGB + homeDisk.usedGB
	totalSize := mainDisk.totalGB + homeDisk.totalGB
	rx, tx := getNetTotals()

	return metrics{
		CPUPercent:     round1(cpu),
		RAMUsedMB:      usedMB,
		RAMCacheMB:     cacheMB,
		RAMTotalMB:     totalMB,
		DiskUsedGB:     round1(totalUsed),
		DiskTotalGB:    round1(totalSize),
		DiskSysUsedGB:  round1(mainDisk.usedGB),
		DiskSysTotalGB: round1(mainDisk.totalGB),
		TemperatureC:   getTemperature(),
		UptimeSeconds:  getUptime(),
		NetInBytes:     rx,
		NetOutBytes:    tx,
	}, nil
}

func round1(v float64) float64 {
	return float64(int64(v*10+0.5)) / 10
}
