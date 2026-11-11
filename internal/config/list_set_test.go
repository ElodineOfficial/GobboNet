package config

import (
	"os"
	"reflect"
	"testing"
)

// 1.8.0 (#68): the Linux setup and CONFIG > Model folders write model_dirs,
// and a folder can have a space in its name. Space-separated, "My Models"
// came back as two folders, "My" and "Models".
func TestSetListTakesAJSONArrayForItemsWithSpaces(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\n")
	want := []string{"/home/me/My Models", `/mnt/odd "quoted" \ name`, "/srv/models"}
	if err := Set(path, "model_dirs", `["/home/me/My Models", "/mnt/odd \"quoted\" \\ name", "/srv/models"]`); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg.ModelDirs, want) {
		t.Errorf("model_dirs = %q, want %q", cfg.ModelDirs, want)
	}
	if err := Set(path, "model_dirs", "[]"); err != nil {
		t.Fatal(err)
	}
	if cfg, _ = Load(path); len(cfg.ModelDirs) != 0 {
		t.Errorf("[] left %q", cfg.ModelDirs)
	}
}

func TestSetListStillSplitsWords(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\n")
	if err := Set(path, "allowed_hosts", "a.example  b.example"); err != nil {
		t.Fatal(err)
	}
	cfg, _ := Load(path)
	if !reflect.DeepEqual(cfg.AllowedHosts, []string{"a.example", "b.example"}) {
		t.Errorf("allowed_hosts = %q", cfg.AllowedHosts)
	}
}

func TestSetListRefusesABrokenArrayBeforeWriting(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\n")
	before, _ := os.ReadFile(path)
	for _, bad := range []string{`["/a", 3]`, `["/a"`, "[\"/a\\u0007b\"]"} {
		if err := Set(path, "model_dirs", bad); err == nil {
			t.Errorf("model_dirs %s was accepted", bad)
		}
	}
	if after, _ := os.ReadFile(path); string(before) != string(after) {
		t.Errorf("a refused list changed the file:\n%s", after)
	}
}

func TestGetJSONKeepsSpacesInListItems(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\nmodel_dirs = [\"/home/me/My Models\"]\n")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := cfg.GetJSON("model_dirs")
	if err != nil || string(raw) != `["/home/me/My Models"]` {
		t.Errorf("GetJSON(model_dirs) = %s, %v", raw, err)
	}
	if raw, _ := cfg.GetJSON("allowed_hosts"); string(raw) != "[]" {
		t.Errorf("an empty list came back as %s, want []", raw)
	}
	if raw, _ := cfg.GetJSON("listen_port"); string(raw) != "9066" {
		t.Errorf("listen_port = %s", raw)
	}
	if _, err := cfg.GetJSON("no_such_key"); err == nil {
		t.Error("an unknown key was answered")
	}
}
