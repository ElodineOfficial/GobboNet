//go:build !windows

package main

func setupConsolePresentation() func() { return func() {} }
