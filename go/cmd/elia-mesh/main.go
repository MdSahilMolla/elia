// Command workspace is the CLI for the peer-to-peer collaborative filesystem.
package main

import (
	"os"

	"elia-go/internal/mesh/cli"
)

func main() {
	os.Exit(cli.Execute(os.Args[1:]))
}
