#!/bin/sh
n=$(tail -n +2 data.csv | wc -l | tr -d " ")
mkdir -p artifacts
echo "$n" > artifacts/tool-used
echo "$n"
