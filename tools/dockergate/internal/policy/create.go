package policy

import (
	"math"
	"strconv"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/jsonx"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
)

// Form is the shape of a create body.
type Form uint8

const (
	// FormBot is the main container of a bot (M) and its replacement (M.next).
	FormBot Form = iota + 1
	// FormHelperPrepare is the root helper that fixes the owner of the three
	// volumes (M.helper, User 0:0).
	FormHelperPrepare
	// FormHelperApply is the helper that applies a profile (M.helper, User
	// 10001:10001).
	FormHelperApply
)

func (f Form) String() string {
	switch f {
	case FormBot:
		return "bot"
	case FormHelperPrepare:
		return "helper.prepare"
	case FormHelperApply:
		return "helper.apply"
	}
	return "unknown"
}

// Env is what the checks of a create body need from the configuration.
type Env struct {
	VolumeRoot string
	Network    string
	// Images is the set of allowed image references (repo@sha256:...).
	Images map[string]struct{}
	// Ceilings of the bot the request is for.
	MaxMemoryMB int64
	MaxCPUs     float64
	MaxPids     int64
}

// Create is a create body that passed every check.
type Create struct {
	Form   Form
	BotKey string
	// Image is the reference (bot, prepare) or the image Id (apply).
	Image string
	// Nonce is N of an apply helper.
	Nonce string
	// Body is the canonical body: the bytes that go to the daemon.
	Body []byte
}

// Binds returns the three bind strings of a bot.
func Binds(volumeRoot, botKey string) []string {
	base := volumeRoot + "/" + botKey
	return []string{
		base + "/hermes:/data/hermes",
		base + "/workspace:/workspace",
		base + "/scratch:/scratch",
	}
}

// ParseCreate checks a create body against the schema of the form that the
// name selects, and rebuilds it. The checks are, in order: strict JSON, the
// exact key set of every level, the value of every field, and last the byte
// comparison with the rebuild (json_not_canonical: key order, whitespace, an
// escape that JSON.stringify would not write).
func ParseCreate(body []byte, r *route.Route, env *Env) (*Create, *deny.Error) {
	root, derr := jsonx.Parse(body)
	if derr != nil {
		return nil, derr
	}
	if root.Kind != jsonx.KindObject {
		return nil, deny.FieldOnly(deny.JSONType, "$")
	}
	var (
		c   *Create
		err *deny.Error
	)
	if r.Suffix == route.SuffixHelper {
		c, err = parseHelper(root, r, env)
	} else {
		c, err = parseBot(root, r, env)
	}
	if err != nil {
		return nil, err
	}
	if string(c.Body) != string(body) {
		return nil, deny.New(deny.JSONNotCanonical)
	}
	return c, nil
}

// --- typed access with reasons ----------------------------------------------

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// object checks that v is an object whose keys are exactly keys, and returns
// its members by key. A key outside the schema is json_unknown_key, a missing
// one is json_value.
func object(v *jsonx.Value, path string, keys ...string) (map[string]*jsonx.Value, *deny.Error) {
	if v.Kind != jsonx.KindObject {
		return nil, deny.FieldOnly(deny.JSONType, path)
	}
	want := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		want[k] = struct{}{}
	}
	got := make(map[string]*jsonx.Value, len(v.Members))
	for _, m := range v.Members {
		if _, ok := want[m.Key]; !ok {
			return nil, deny.Field(deny.JSONUnknownKey, path, []byte(m.Key))
		}
		got[m.Key] = m.Val
	}
	for _, k := range keys {
		if _, ok := got[k]; !ok {
			return nil, deny.FieldOnly(deny.JSONValue, join(path, k))
		}
	}
	return got, nil
}

func str(v *jsonx.Value, path string) (string, *deny.Error) {
	if v.Kind != jsonx.KindString {
		return "", deny.FieldOnly(deny.JSONType, path)
	}
	return v.S, nil
}

func integer(v *jsonx.Value, path string) (int64, *deny.Error) {
	if v.Kind != jsonx.KindInt {
		return 0, deny.FieldOnly(deny.JSONType, path)
	}
	return v.N, nil
}

func boolean(v *jsonx.Value, path string) (bool, *deny.Error) {
	if v.Kind != jsonx.KindBool {
		return false, deny.FieldOnly(deny.JSONType, path)
	}
	return v.B, nil
}

func strList(v *jsonx.Value, path string) ([]string, *deny.Error) {
	if v.Kind != jsonx.KindArray {
		return nil, deny.FieldOnly(deny.JSONType, path)
	}
	out := make([]string, 0, len(v.Elems))
	for i, e := range v.Elems {
		s, err := str(e, path+"["+strconv.Itoa(i)+"]")
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// wantStr requires the string value of a fixed field.
func wantStr(v *jsonx.Value, path, want, code string) *deny.Error {
	s, err := str(v, path)
	if err != nil {
		return err
	}
	if s != want {
		return deny.Field(code, path, []byte(s))
	}
	return nil
}

func wantBool(v *jsonx.Value, path string, want bool) *deny.Error {
	b, err := boolean(v, path)
	if err != nil {
		return err
	}
	if b != want {
		return deny.FieldOnly(deny.JSONValue, path)
	}
	return nil
}

func wantInt(v *jsonx.Value, path string, want int64) *deny.Error {
	n, err := integer(v, path)
	if err != nil {
		return err
	}
	if n != want {
		return deny.FieldOnly(deny.JSONValue, path)
	}
	return nil
}

// wantList requires a string array equal to want. The code is the reason of a
// value that differs.
func wantList(v *jsonx.Value, path string, want []string, code string) *deny.Error {
	got, err := strList(v, path)
	if err != nil {
		return err
	}
	equal := len(got) == len(want)
	for i := 0; equal && i < len(got); i++ {
		equal = got[i] == want[i]
	}
	if !equal {
		joined := ""
		for _, g := range got {
			joined += g + "\x00"
		}
		return deny.Field(code, path, []byte(joined))
	}
	return nil
}

// wantSingle requires an object {key: value} with a string value.
func wantSingle(v *jsonx.Value, path, key, value string) *deny.Error {
	m, err := object(v, path, key)
	if err != nil {
		return err
	}
	return wantStr(m[key], join(path, key), value, deny.JSONValue)
}

// --- bot form ---------------------------------------------------------------

func parseBot(root *jsonx.Value, r *route.Route, env *Env) (*Create, *deny.Error) {
	top, err := object(root, "", "Image", "Labels", "HostConfig")
	if err != nil {
		return nil, err
	}
	image, err := str(top["Image"], "Image")
	if err != nil {
		return nil, err
	}
	if _, ok := env.Images[image]; !ok {
		return nil, deny.Field(deny.ImageNotAllowed, "Image", []byte(image))
	}

	labels, err := object(top["Labels"], "Labels", "myrmidon.bot", "myrmidon.image")
	if err != nil {
		return nil, err
	}
	if err := wantStr(labels["myrmidon.bot"], "Labels.myrmidon.bot", r.BotKey, deny.NameLabelMismatch); err != nil {
		return nil, err
	}
	if err := wantStr(labels["myrmidon.image"], "Labels.myrmidon.image", image, deny.JSONValue); err != nil {
		return nil, err
	}

	hc, err := object(top["HostConfig"], "HostConfig",
		"Memory", "NanoCpus", "PidsLimit", "CapDrop", "SecurityOpt", "ReadonlyRootfs", "Tmpfs",
		"Init", "RestartPolicy", "NetworkMode", "Binds", "Privileged")
	if err != nil {
		return nil, err
	}
	memory, err := ceiling(hc["Memory"], "HostConfig.Memory", env.MaxMemoryMB*1048576)
	if err != nil {
		return nil, err
	}
	nano, err := ceiling(hc["NanoCpus"], "HostConfig.NanoCpus", int64(math.Round(env.MaxCPUs*1e9)))
	if err != nil {
		return nil, err
	}
	pids, err := ceiling(hc["PidsLimit"], "HostConfig.PidsLimit", env.MaxPids)
	if err != nil {
		return nil, err
	}
	if err := commonHostConfig(hc, "on-failure"); err != nil {
		return nil, err
	}
	tmpfs, err := object(hc["Tmpfs"], "HostConfig.Tmpfs", "/tmp")
	if err != nil {
		return nil, err
	}
	if err := wantStr(tmpfs["/tmp"], "HostConfig.Tmpfs./tmp", "", deny.JSONValue); err != nil {
		return nil, err
	}
	if err := wantBool(hc["Init"], "HostConfig.Init", true); err != nil {
		return nil, err
	}
	if err := wantStr(hc["NetworkMode"], "HostConfig.NetworkMode", env.Network, deny.NetworkMismatch); err != nil {
		return nil, err
	}
	binds := Binds(env.VolumeRoot, r.BotKey)
	if err := wantList(hc["Binds"], "HostConfig.Binds", binds, deny.BindsMismatch); err != nil {
		return nil, err
	}

	w := &writer{}
	w.raw(`{"Image":`).str(image)
	w.raw(`,"Labels":{"myrmidon.bot":`).str(r.BotKey).raw(`,"myrmidon.image":`).str(image).raw(`}`)
	w.raw(`,"HostConfig":{"Memory":`).int(memory).raw(`,"NanoCpus":`).int(nano).raw(`,"PidsLimit":`).int(pids)
	w.raw(`,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"ReadonlyRootfs":true`)
	w.raw(`,"Tmpfs":{"/tmp":""},"Init":true,"RestartPolicy":{"Name":"on-failure"}`)
	w.raw(`,"NetworkMode":`).str(env.Network).raw(`,"Binds":`).strs(binds).raw(`,"Privileged":false}}`)
	return &Create{Form: FormBot, BotKey: r.BotKey, Image: image, Body: w.b}, nil
}

// ceiling reads a resource limit: 0 < value <= max. A limit above the
// enrolled ceiling is limit_exceeds_enrollment; a non-positive one is
// json_value.
func ceiling(v *jsonx.Value, path string, max int64) (int64, *deny.Error) {
	n, err := integer(v, path)
	if err != nil {
		return 0, err
	}
	if n <= 0 {
		return 0, deny.FieldOnly(deny.JSONValue, path)
	}
	if n > max {
		return 0, deny.FieldOnly(deny.LimitExceedsEnrolled, path)
	}
	return n, nil
}

// commonHostConfig checks the fields that the bot and the helper have in
// common: CapDrop, SecurityOpt, ReadonlyRootfs, RestartPolicy, Privileged.
// The reason of a wrong value is json_value; the fields with a reason of their
// own (Memory, NetworkMode, Binds) are checked by the callers.
func commonHostConfig(hc map[string]*jsonx.Value, restart string) *deny.Error {
	if err := wantList(hc["CapDrop"], "HostConfig.CapDrop", []string{"ALL"}, deny.JSONValue); err != nil {
		return err
	}
	if err := wantList(hc["SecurityOpt"], "HostConfig.SecurityOpt", []string{"no-new-privileges"}, deny.JSONValue); err != nil {
		return err
	}
	if err := wantBool(hc["ReadonlyRootfs"], "HostConfig.ReadonlyRootfs", true); err != nil {
		return err
	}
	if err := wantSingle(hc["RestartPolicy"], "HostConfig.RestartPolicy", "Name", restart); err != nil {
		return err
	}
	return wantBool(hc["Privileged"], "HostConfig.Privileged", false)
}

// --- helper forms -----------------------------------------------------------

const (
	helperMemory = 134217728
	helperPids   = 64
)

func parseHelper(root *jsonx.Value, r *route.Route, env *Env) (*Create, *deny.Error) {
	top, err := object(root, "", "Image", "User", "Entrypoint", "Cmd", "Labels", "NetworkDisabled", "HostConfig")
	if err != nil {
		return nil, err
	}
	user, err := str(top["User"], "User")
	if err != nil {
		return nil, err
	}
	var form Form
	switch user {
	case "0:0":
		form = FormHelperPrepare
	case "10001:10001":
		form = FormHelperApply
	default:
		return nil, deny.Field(deny.JSONValue, "User", []byte(user))
	}

	image, err := str(top["Image"], "Image")
	if err != nil {
		return nil, err
	}
	if form == FormHelperPrepare {
		if _, ok := env.Images[image]; !ok {
			return nil, deny.Field(deny.ImageNotAllowed, "Image", []byte(image))
		}
	} else if !IsImageID(image) {
		return nil, deny.Field(deny.ImageNotAllowed, "Image", []byte(image))
	}

	if err := wantList(top["Entrypoint"], "Entrypoint", []string{"/bin/sh", "-c"}, deny.JSONValue); err != nil {
		return nil, err
	}
	cmd, err := strList(top["Cmd"], "Cmd")
	if err != nil {
		return nil, err
	}
	if len(cmd) != 3 {
		return nil, deny.FieldOnly(deny.JSONValue, "Cmd")
	}
	if cmd[1] != "myrmidon-helper" || cmd[2] != "/" {
		return nil, deny.FieldOnly(deny.JSONValue, "Cmd")
	}
	var nonce string
	if form == FormHelperPrepare {
		if cmd[0] != PrepareScript {
			return nil, deny.Field(deny.ScriptMismatch, "Cmd[0]", []byte(cmd[0])).WithDetail("prepare")
		}
	} else {
		n, derr := ExtractNonce(cmd[0])
		if derr != nil {
			return nil, derr.At("Cmd[0]", []byte(cmd[0]))
		}
		nonce = n
	}

	labels, err := object(top["Labels"], "Labels", "myrmidon.bot-helper")
	if err != nil {
		return nil, err
	}
	if err := wantStr(labels["myrmidon.bot-helper"], "Labels.myrmidon.bot-helper", r.BotKey, deny.NameLabelMismatch); err != nil {
		return nil, err
	}
	if err := wantBool(top["NetworkDisabled"], "NetworkDisabled", true); err != nil {
		return nil, err
	}

	hc, err := object(top["HostConfig"], "HostConfig",
		"Memory", "PidsLimit", "CapDrop", "CapAdd", "SecurityOpt", "ReadonlyRootfs",
		"RestartPolicy", "NetworkMode", "Binds", "Privileged")
	if err != nil {
		return nil, err
	}
	if err := wantInt(hc["Memory"], "HostConfig.Memory", helperMemory); err != nil {
		return nil, err
	}
	if err := wantInt(hc["PidsLimit"], "HostConfig.PidsLimit", helperPids); err != nil {
		return nil, err
	}
	capAdd := []string{"CHOWN", "FOWNER"}
	if form == FormHelperApply {
		capAdd = []string{}
	}
	if err := wantList(hc["CapAdd"], "HostConfig.CapAdd", capAdd, deny.JSONValue); err != nil {
		return nil, err
	}
	if err := commonHostConfig(hc, "no"); err != nil {
		return nil, err
	}
	if err := wantStr(hc["NetworkMode"], "HostConfig.NetworkMode", "none", deny.JSONValue); err != nil {
		return nil, err
	}
	binds := Binds(env.VolumeRoot, r.BotKey)
	if err := wantList(hc["Binds"], "HostConfig.Binds", binds, deny.BindsMismatch); err != nil {
		return nil, err
	}

	w := &writer{}
	w.raw(`{"Image":`).str(image).raw(`,"User":`).str(user)
	w.raw(`,"Entrypoint":["/bin/sh","-c"],"Cmd":[`).str(cmd[0]).raw(`,"myrmidon-helper","/"]`)
	w.raw(`,"Labels":{"myrmidon.bot-helper":`).str(r.BotKey).raw(`},"NetworkDisabled":true`)
	w.raw(`,"HostConfig":{"Memory":134217728,"PidsLimit":64,"CapDrop":["ALL"],"CapAdd":`).strs(capAdd)
	w.raw(`,"SecurityOpt":["no-new-privileges"],"ReadonlyRootfs":true,"RestartPolicy":{"Name":"no"}`)
	w.raw(`,"NetworkMode":"none","Binds":`).strs(binds).raw(`,"Privileged":false}}`)
	return &Create{Form: form, BotKey: r.BotKey, Image: image, Nonce: nonce, Body: w.b}, nil
}
