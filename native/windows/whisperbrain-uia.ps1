# Accessibility helper for Windows: reads the page of a browser window (UI Automation) and prints it as JSON lines.
#   powershell -NoProfile -ExecutionPolicy Bypass -File whisperbrain-uia.ps1 -Mode watch|dump|windows|selftest [-IntervalMs 500] [-Apps REGEX] [-Title REGEX] [-MaxNodes 8000]
#
# The same lines as the Linux helper (native/atspi), so one reader (src/meet/a11y.js) serves every system:
#   {"event":"hello","helper":"uia","version":1}
#   {"event":"status","state":"ok"|"no-window"|"no-web-tree"|"no-apps","app":"...","window":"..."}   only when it changes
#   {"event":"snapshot","platform":"win32","app":"...","window":"...","ms":12,"truncated":false,"nodes":[{"p":-1,"r":"Document","n":"...","a":{"class":"...","id":"..."},"s":["focused"]},...]}
# Roles are the UI Automation control types ("Text", "List", "Group"…); src/meet/roles.js puts them in the common vocabulary.
#
# Chromium builds the page's accessibility tree once a UI Automation client asks for it, so nothing has to be switched
# on: the first snapshots may report "no-web-tree" for a moment. The C# below is compiled when the script starts (the
# .NET Framework that comes with Windows does it, no SDK needed). -Mode selftest compiles it and exits: what CI runs.
param(
  [string]$Mode = 'watch',
  [int]$IntervalMs = 500,
  [string]$Apps = 'chrome|msedge|brave|vivaldi|opera|chromium',
  [string]$Title = 'meet|[a-z]{3}-[a-z]{4}-[a-z]{3}',
  [int]$MaxNodes = 8000
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$refs = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location, 'System.Core')
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;

public static class WbUia
{
    static void Str(StringBuilder b, string s)
    {
        b.Append('"');
        foreach (char c in s ?? "")
        {
            switch (c)
            {
                case '"': b.Append("\\\""); break;
                case '\\': b.Append("\\\\"); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                    else b.Append(c);
                    break;
            }
        }
        b.Append('"');
    }

    static CacheRequest MakeCache()
    {
        var cr = new CacheRequest();
        cr.Add(AutomationElement.NameProperty);
        cr.Add(AutomationElement.ControlTypeProperty);
        cr.Add(AutomationElement.ClassNameProperty);
        cr.Add(AutomationElement.AutomationIdProperty);
        cr.Add(AutomationElement.HasKeyboardFocusProperty);
        cr.TreeFilter = Automation.ControlViewCondition;
        return cr;
    }

    static bool truncated;
    static int count;

    static void Walk(AutomationElement el, int parent, int depth, StringBuilder b, TreeWalker walker, CacheRequest cr, int max)
    {
        if (count >= max) { truncated = true; return; }
        if (depth > 120) return;
        int me = count++;
        if (me > 0) b.Append(',');
        string type = el.Cached.ControlType.ProgrammaticName.Replace("ControlType.", "");
        b.Append("{\"p\":").Append(parent).Append(",\"r\":"); Str(b, type);
        b.Append(",\"n\":"); Str(b, el.Cached.Name);
        string cls = el.Cached.ClassName, id = el.Cached.AutomationId;
        if (!string.IsNullOrEmpty(cls) || !string.IsNullOrEmpty(id))
        {
            b.Append(",\"a\":{");
            if (!string.IsNullOrEmpty(cls)) { b.Append("\"class\":"); Str(b, cls); }
            if (!string.IsNullOrEmpty(id)) { if (!string.IsNullOrEmpty(cls)) b.Append(','); b.Append("\"id\":"); Str(b, id); }
            b.Append('}');
        }
        b.Append(",\"s\":[").Append(el.Cached.HasKeyboardFocus ? "\"focused\"" : "").Append("]}");
        AutomationElement child = walker.GetFirstChild(el, cr);
        while (child != null && !truncated)
        {
            Walk(child, me, depth + 1, b, walker, cr, max);
            child = walker.GetNextSibling(child, cr);
        }
    }

    // the page of a window: the first Document found
    static AutomationElement FindDocument(AutomationElement win)
    {
        return win.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
    }

    // -> the "snapshot" line for one window, or null when the window has no page tree yet
    public static string Snapshot(AutomationElement win, string app, string title, int max)
    {
        AutomationElement doc = FindDocument(win);
        if (doc == null) return null;
        var cr = MakeCache();
        var sw = Stopwatch.StartNew();
        var b = new StringBuilder();
        truncated = false; count = 0;
        using (cr.Activate())
        {
            AutomationElement cached = doc.GetUpdatedCache(cr);
            Walk(cached, -1, 0, b, TreeWalker.ControlViewWalker, cr, max);
        }
        var o = new StringBuilder("{\"event\":\"snapshot\",\"platform\":\"win32\",\"app\":");
        Str(o, app); o.Append(",\"window\":"); Str(o, title);
        o.Append(",\"ms\":").Append(sw.ElapsedMilliseconds).Append(",\"truncated\":").Append(truncated ? "true" : "false").Append(",\"nodes\":[").Append(b).Append("]}");
        return o.ToString();
    }

    public static string Quote(string s) { var b = new StringBuilder(); Str(b, s); return b.ToString(); }

    // top-level windows of the processes whose name matches
    public static List<KeyValuePair<AutomationElement, string>> Windows(Regex apps)
    {
        var list = new List<KeyValuePair<AutomationElement, string>>();
        var all = AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window));
        foreach (AutomationElement w in all)
        {
            string name;
            try { name = Process.GetProcessById(w.Current.ProcessId).ProcessName; } catch { continue; }
            if (apps.IsMatch(name)) list.Add(new KeyValuePair<AutomationElement, string>(w, name));
        }
        return list;
    }
}
'@

function Out-Json([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }

Out-Json '{"event":"hello","helper":"uia","version":1}'
if ($Mode -eq 'selftest') { exit 0 }

$appRe = New-Object System.Text.RegularExpressions.Regex($Apps, 'IgnoreCase')
$titleRe = New-Object System.Text.RegularExpressions.Regex($Title, 'IgnoreCase')
$lastKey = ''
function Set-State([string]$state, [string]$app, [string]$window) {
  $key = "$state|$app|$window"
  if ($key -ne $script:lastKey) {
    $script:lastKey = $key
    Out-Json ('{"event":"status","state":"' + $state + '","app":' + [WbUia]::Quote($app) + ',"window":' + [WbUia]::Quote($window) + '}')
  }
}

while ($true) {
  $t0 = Get-Date
  $wins = [WbUia]::Windows($appRe)
  if ($Mode -eq 'windows') {
    $items = @()
    foreach ($kv in $wins) { $items += ('{"app":' + [WbUia]::Quote($kv.Value) + ',"title":' + [WbUia]::Quote($kv.Key.Current.Name) + ',"pid":' + $kv.Key.Current.ProcessId + '}') }
    Out-Json ('{"event":"windows","windows":[' + ($items -join ',') + ']}')
    exit 0
  }
  if ($wins.Count -eq 0) { Set-State 'no-apps' '' '' }
  $saw = $false
  foreach ($kv in $wins) {
    $title = $kv.Key.Current.Name
    if (-not $titleRe.IsMatch($title)) { continue }
    $saw = $true
    $limit = $MaxNodes
    if ($Mode -eq 'dump') { $limit = 1000000 }
    $line = [WbUia]::Snapshot($kv.Key, $kv.Value, $title, $limit)
    if ($null -eq $line) { Set-State 'no-web-tree' $kv.Value $title; continue }
    Set-State 'ok' $kv.Value $title
    Out-Json $line
    if ($Mode -eq 'dump') { exit 0 }
  }
  if ($Mode -eq 'dump') { exit 1 }
  if ($wins.Count -gt 0 -and -not $saw) { Set-State 'no-window' '' '' }
  $took = [int]((Get-Date) - $t0).TotalMilliseconds
  Start-Sleep -Milliseconds ([Math]::Max($IntervalMs, $took * 3))
}
