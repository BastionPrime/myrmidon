// Command dockergate is an allowlisting proxy in front of the Docker socket,
// for the container driver of the board. See docs/myrmidon/dockergate.md.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/gate"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func fullVersion() string {
	v := version
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 12 {
				v += "+" + s.Value[:12]
			}
		}
	}
	return v
}

const usage = `usage: dockergate <command>

  serve --config <file>          run the proxy
  check-config --config <file>   check a configuration file and exit
  version                        print the version
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	switch args[0] {
	case "version":
		fmt.Println(fullVersion())
		return 0
	case "check-config":
		return checkConfig(args[1:])
	case "serve":
		return serve(args[1:])
	case "-h", "--help", "help":
		fmt.Print(usage)
		return 0
	}
	fmt.Fprint(os.Stderr, usage)
	return 2
}

func configFlag(name string, args []string) (string, bool) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	path := fs.String("config", "", "path of the configuration file")
	if err := fs.Parse(args); err != nil || *path == "" || fs.NArg() != 0 {
		fmt.Fprint(os.Stderr, usage)
		return "", false
	}
	return *path, true
}

func checkConfig(args []string) int {
	path, ok := configFlag("check-config", args)
	if !ok {
		return 2
	}
	cfg, hash, err := config.Load(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("config ok (hash %s, %d bot(s), %d image(s))\n", hash, len(cfg.Bots), len(cfg.Images))
	return 0
}

func serve(args []string) int {
	path, ok := configFlag("serve", args)
	if !ok {
		return 2
	}
	cfg, hash, err := config.Load(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	g, err := gate.New(gate.Options{
		Cfg: cfg, ConfigHash: hash, ConfigPath: path, Version: fullVersion(), Log: os.Stdout,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer g.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := g.SelfCheck(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ln, err := g.Listen()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for {
			select {
			case <-hup:
				g.Reload()
			case <-ctx.Done():
				return
			}
		}
	}()

	if err := g.Serve(ctx, ln); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
