/* eslint-disable max-lines, max-lines-per-function */

import { Button, Input } from '@benord-labs/frink-primitives';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  authType?: string;
  url?: string;
  requiredEnvVars?: string[];
  existingEnv?: Record<string, string>;
  existingHeaders?: Record<string, string>;
  onSave: (creds: {
    env?: Record<string, string>;
    headers?: Record<string, string>;
  }) => Promise<void>;
  onStartOAuth?: () => Promise<void>;
  isOAuthInProgress?: boolean;
};

export const ConfigureMcpDialog = memo(function ConfigureMcpDialog({
  open,
  onOpenChange,
  serverName,
  authType,
  url,
  requiredEnvVars = [],
  existingEnv = {},
  existingHeaders = {},
  onSave,
  onStartOAuth,
  isOAuthInProgress = false,
}: Props) {
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [apiKey, setApiKey] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [headersInitialized, setHeadersInitialized] = useState(false);
  const [envInitialized, setEnvInitialized] = useState(false);
  const [userHasEditedEnv, setUserHasEditedEnv] = useState(false);
  const [customEnvName, setCustomEnvName] = useState('');
  const [customEnvValue, setCustomEnvValue] = useState('');
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({});

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setHeadersInitialized(false);
      setEnvInitialized(false);
      setApiKey('');
      setHeaderName('');
      setEnvVars({});
      setUserHasEditedEnv(false);
      setCustomEnvName('');
      setCustomEnvValue('');
      setVisibleFields({});
    }
  }, [open]);

  // Initialize header/auth fields when existing headers arrive.
  // Keep this separate from env initialization so delayed async hydration still works.
  useEffect(() => {
    if (!open || headersInitialized) return;
    if (existingHeaders && Object.keys(existingHeaders).length > 0) {
      const entries = Object.entries(existingHeaders);
      const [name, value] = entries[0];
      setHeaderName(name);
      setApiKey(value.startsWith('Bearer ') ? value.slice(7) : value);
    }
    setHeadersInitialized(true);
  }, [open, headersInitialized, existingHeaders]);

  // Initialize env inputs from requiredEnvVars and existingEnv.
  // If existingEnv arrives later, hydrate once unless user has already typed.
  useEffect(() => {
    if (!open || requiredEnvVars.length === 0) return;

    const hasExistingEnv = Object.keys(existingEnv).length > 0;
    const shouldHydrate = !envInitialized || (hasExistingEnv && !userHasEditedEnv);
    if (!shouldHydrate) return;

    const initialEnvVars: Record<string, string> = {};
    for (const key of requiredEnvVars) {
      initialEnvVars[key] = existingEnv[key] || '';
    }
    setEnvVars(initialEnvVars);
    setEnvInitialized(true);
  }, [open, requiredEnvVars, existingEnv, envInitialized, userHasEditedEnv]);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    try {
      if (authType === 'api_key' || authType === 'bearer' || (url && authType === 'none')) {
        if (!apiKey.trim()) {
          toast.error(
            authType === 'bearer' ? 'Bearer token is required' : 'API key or token is required',
          );
          return;
        }
        const headers: Record<string, string> = {};
        if (authType === 'bearer') {
          headers.Authorization = `Bearer ${apiKey.trim()}`;
        } else if (headerName) {
          headers[headerName] = apiKey.trim();
        } else {
          headers.Authorization = apiKey.trim();
        }
        await onSave({ headers });
      } else if (requiredEnvVars.length > 0) {
        await onSave({ env: envVars });
      } else if (customEnvName && customEnvValue) {
        await onSave({ env: { [customEnvName]: customEnvValue } });
      }
      onOpenChange(false);
      toast.success('Credentials saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save credentials');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    authType,
    url,
    apiKey,
    headerName,
    requiredEnvVars,
    envVars,
    customEnvName,
    customEnvValue,
    onSave,
    onOpenChange,
  ]);

  const handleEnvVarChange = useCallback((key: string, value: string) => {
    setUserHasEditedEnv(true);
    setEnvVars((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleFieldVisibility = useCallback((fieldId: string) => {
    setVisibleFields((prev) => ({ ...prev, [fieldId]: !prev[fieldId] }));
  }, []);

  const isOAuth = authType === 'oauth';
  const isApiKeyOrBearer =
    authType === 'api_key' || authType === 'bearer' || (url && authType === 'none');
  const hasEnvVars = requiredEnvVars.length > 0;
  const isCommandBased = !url && !isOAuth;
  const needsInput = isApiKeyOrBearer || hasEnvVars || isCommandBased;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {serverName}</DialogTitle>
          <DialogDescription>
            {isOAuth
              ? 'This MCP server uses OAuth authentication.'
              : isApiKeyOrBearer
                ? 'Enter the API key or token for this MCP server.'
                : hasEnvVars
                  ? 'Configure credentials for these MCP environment keys (required and rotatable).'
                  : isCommandBased
                    ? 'Configure environment variables for this MCP server.'
                    : 'Configure credentials for this MCP server.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {isOAuth ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This server authenticates through its own OAuth flow. When you use this MCP, it will
                prompt you to authenticate if needed.
              </p>
              {url && (
                <div className="text-xs font-mono text-muted-foreground bg-muted p-2 rounded break-all">
                  {url}
                </div>
              )}
            </div>
          ) : isApiKeyOrBearer ? (
            <div className="space-y-4">
              {authType === 'api_key' && (
                <div className="space-y-2">
                  <Label htmlFor="header-name">Header Name</Label>
                  <Input
                    id="header-name"
                    placeholder="e.g., Authorization, X-API-Key, CONTEXT7_API_KEY"
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    The HTTP header name used by this MCP (check their docs)
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="api-key">
                  {authType === 'bearer' ? 'Bearer Token' : 'API Key / Token'}
                </Label>
                <div className="relative">
                  <Input
                    id="api-key"
                    type={visibleFields['api-key'] ? 'text' : 'password'}
                    placeholder={authType === 'bearer' ? 'Enter Bearer token' : 'Enter API key'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="pr-9"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggleFieldVisibility('api-key')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-transparent"
                    aria-label={visibleFields['api-key'] ? 'Hide value' : 'Show value'}
                  >
                    {visibleFields['api-key'] ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ) : hasEnvVars ? (
            requiredEnvVars.map((key) => {
              const fieldId = `env-${key}`;
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={fieldId}>{key}</Label>
                  <div className="relative">
                    <Input
                      id={fieldId}
                      type={visibleFields[fieldId] ? 'text' : 'password'}
                      placeholder={`Enter ${key}`}
                      value={envVars[key] || ''}
                      onChange={(e) => handleEnvVarChange(key, e.target.value)}
                      className="pr-9"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleFieldVisibility(fieldId)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-transparent"
                      aria-label={visibleFields[fieldId] ? 'Hide value' : 'Show value'}
                    >
                      {visibleFields[fieldId] ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              );
            })
          ) : isCommandBased ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This MCP may require an API key or token. Check the MCP's documentation for the
                correct environment variable name.
              </p>
              <div className="space-y-2">
                <Label htmlFor="env-name">Environment Variable Name</Label>
                <Input
                  id="env-name"
                  placeholder="e.g., TWENTY_FIRST_API_KEY, API_KEY"
                  value={customEnvName}
                  onChange={(e) => setCustomEnvName(e.target.value.toUpperCase())}
                />
                <p className="text-xs text-muted-foreground">
                  Common names: *_API_KEY, *_TOKEN, *_SECRET
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="env-value">Value</Label>
                <div className="relative">
                  <Input
                    id="env-value"
                    type={visibleFields['env-value'] ? 'text' : 'password'}
                    placeholder="Enter your API key or token"
                    value={customEnvValue}
                    onChange={(e) => setCustomEnvValue(e.target.value)}
                    className="pr-9"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggleFieldVisibility('env-value')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-transparent"
                    aria-label={visibleFields['env-value'] ? 'Hide value' : 'Show value'}
                  >
                    {visibleFields['env-value'] ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No specific credentials required. The server may use system environment variables.
            </p>
          )}
          {needsInput && (
            <p className="text-xs text-muted-foreground">
              Credentials are stored locally and encrypted. Never synced to cloud.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isOAuthInProgress}
          >
            {needsInput || isOAuth ? 'Cancel' : 'Close'}
          </Button>
          {needsInput && (
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          )}
          {isOAuth && onStartOAuth && (
            <Button onClick={onStartOAuth} disabled={isOAuthInProgress}>
              {isOAuthInProgress ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Waiting for browser…
                </>
              ) : (
                'Authenticate'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
