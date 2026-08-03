#!/bin/sh
case "$1" in
  *Username*) printf '%s' "${GIT_USERNAME:-oauth2}" ;;
  *Password*) printf '%s' "${GIT_TOKEN:?GIT_TOKEN is required}" ;;
  *) exit 1 ;;
esac
