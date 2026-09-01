package main

import (
	"log"
	"net/http"
)

func main() {
	log.Println("berth proxy listening on :3000")
	log.Fatal(http.ListenAndServe(":3000", http.NotFoundHandler()))
}
