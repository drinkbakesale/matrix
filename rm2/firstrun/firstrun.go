// Package firstrun decides, from the device itself, whether this client may
// touch the display. It fails closed: an unknown model, an unknown or
// malformed software version or a missing display backend is a refusal with
// the exact value found, and no display call is made.
package firstrun

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

//go:embed support.json
var supportJSON []byte

type Support struct {
	Model    string   `json:"model"`
	Releases []string `json:"releases"` // major.minor lines verified against the pinned AppLoad
	AppLoad  string   `json:"appload"`
	Evidence string   `json:"evidence"`
}

func LoadSupport() Support {
	var s Support
	if err := json.Unmarshal(supportJSON, &s); err != nil {
		panic("embedded support.json is invalid: " + err.Error())
	}
	return s
}

type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

type Report struct {
	Supported bool    `json:"supported"`
	Code      int     `json:"code"` // process exit code
	Reason    string  `json:"reason"`
	Model     string  `json:"model"`
	Version   string  `json:"version"`
	Client    string  `json:"client"`
	Checks    []Check `json:"checks"`
	Recovery  string  `json:"recovery"`
}

const (
	CodeOK          = 0
	CodeVersion     = 4
	CodeModel       = 5
	CodeMalformed   = 6
	CodeBackend     = 7
	CodeDisplayFail = 8
	CodeTouchFail   = 9
)

var versionRe = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)\.(\d+)$`)

func readTrim(path string) (string, error) {
	b, err := os.ReadFile(path)
	return strings.TrimRight(strings.TrimSpace(string(b)), "\x00"), err
}

func keyValue(text, key string) string {
	for _, line := range strings.Split(text, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), key+"="); ok {
			return strings.Trim(v, `"'`)
		}
	}
	return ""
}

// detectVersion reads the release version the way the device reports it.
func detectVersion(root string) (string, string) {
	if t, err := readTrim(filepath.Join(root, "etc/os-release")); err == nil {
		if v := keyValue(t, "IMG_VERSION"); v != "" {
			return v, "/etc/os-release IMG_VERSION"
		}
	}
	if t, err := readTrim(filepath.Join(root, "usr/share/remarkable/update.conf")); err == nil {
		if v := keyValue(t, "REMARKABLE_RELEASE_VERSION"); v != "" {
			return v, "/usr/share/remarkable/update.conf REMARKABLE_RELEASE_VERSION"
		}
	}
	return "", ""
}

// Inspect performs the file-level checks. root is "/" on the device.
func Inspect(root, xoviDir, client string) Report {
	sup := LoadSupport()
	r := Report{Client: client, Recovery: "Nothing on the tablet was changed by this check. The stock reMarkable interface is unaffected."}
	add := func(name string, ok bool, detail string) { r.Checks = append(r.Checks, Check{name, ok, detail}) }
	refuse := func(code int, reason string) Report { r.Supported, r.Code, r.Reason = false, code, reason; return r }

	model, err := readTrim(filepath.Join(root, "sys/devices/soc0/machine"))
	if err != nil {
		add("model", false, "cannot read /sys/devices/soc0/machine: "+err.Error())
		return refuse(CodeModel, "the device model could not be read")
	}
	r.Model = model
	if model != sup.Model {
		add("model", false, fmt.Sprintf("found %q, this client supports only %q", model, sup.Model))
		return refuse(CodeModel, fmt.Sprintf("unsupported hardware model %q", model))
	}
	add("model", true, model)

	version, source := detectVersion(root)
	if version == "" {
		add("software version", false, "no version found in /etc/os-release or /usr/share/remarkable/update.conf")
		return refuse(CodeMalformed, "the software version could not be read")
	}
	r.Version = version
	m := versionRe.FindStringSubmatch(version)
	if m == nil {
		add("software version", false, fmt.Sprintf("found %q (%s): not a release version", version, source))
		return refuse(CodeMalformed, fmt.Sprintf("malformed software version %q", version))
	}
	line := m[1] + "." + m[2]
	ok := false
	for _, rel := range sup.Releases {
		ok = ok || rel == line
	}
	if !ok {
		add("software version", false, fmt.Sprintf("found %s (%s); supported release lines: %s", version, source, strings.Join(sup.Releases, ", ")))
		return refuse(CodeVersion, fmt.Sprintf("software version %s is not supported (supported: %s)", version, strings.Join(sup.Releases, ", ")))
	}
	add("software version", true, fmt.Sprintf("%s (%s)", version, source))

	// The display backend: XOVI + AppLoad with its QTFB server, at the pinned build.
	for _, f := range []struct{ rel, what string }{
		{"xovi.so", "XOVI loader"},
		{"extensions.d/qt-resource-rebuilder.so", "qt-resource-rebuilder extension"},
		{"extensions.d/appload.so", "AppLoad extension (QTFB display and touch)"},
	} {
		p := filepath.Join(root, xoviDir, f.rel)
		if st, err := os.Stat(p); err != nil || st.Size() == 0 {
			add("display backend", false, fmt.Sprintf("%s missing at %s", f.what, filepath.Join("/", xoviDir, f.rel)))
			return refuse(CodeBackend, fmt.Sprintf("display backend incomplete: %s is missing", f.what))
		}
	}
	add("display backend", true, "XOVI, qt-resource-rebuilder and AppLoad "+sup.AppLoad+" present")
	if st, err := os.Stat(filepath.Join(root, xoviDir, "exthome/qt-resource-rebuilder/hashtab")); err != nil || st.Size() == 0 {
		add("hashtable", false, "not built for this software version: run xovi/rebuild_hashtable on the tablet (one-time, see setup step)")
		return refuse(CodeBackend, "the XOVI hashtable for this software version has not been built")
	}
	add("hashtable", true, "present")
	r.Supported, r.Code, r.Reason = true, CodeOK, "supported"
	return r
}

// Text renders the report for a terminal, the RM2 screen or the PDF.
func (r Report) Text() []string {
	head := "SUPPORTED — the Matrix e-ink client may run on this tablet."
	if !r.Supported {
		head = "NOT SUPPORTED — the Matrix e-ink client will not run: " + r.Reason
	}
	out := []string{"Matrix e-ink client first-run report", head, "",
		"Device model: " + nonEmpty(r.Model), "Software version: " + nonEmpty(r.Version), "Client build: " + nonEmpty(r.Client), ""}
	for _, c := range r.Checks {
		mark := "PASS"
		if !c.OK {
			mark = "FAIL"
		}
		out = append(out, fmt.Sprintf("[%s] %s: %s", mark, c.Name, c.Detail))
	}
	return append(out, "", r.Recovery)
}

func nonEmpty(s string) string {
	if s == "" {
		return "(not readable)"
	}
	return s
}
