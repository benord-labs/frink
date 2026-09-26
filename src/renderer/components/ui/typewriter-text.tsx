import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

type TypewriterTextProps = {
  text: string;
  placeholder?: string;
  id?: string;
  className?: string;
  /** If true (item created in this session), show placeholder until name generates, then typewriter */
  isJustCreated?: boolean;
  /** If true, show placeholder when text is empty */
  showPlaceholder?: boolean;
};

export const TypewriterText = memo(function TypewriterText({
  text,
  placeholder = 'New workspace',
  id,
  className,
  isJustCreated = false,
  showPlaceholder = false,
}: TypewriterTextProps) {
  const [isTyping, setIsTyping] = useState(false);
  const [typedLength, setTypedLength] = useState(0);
  const [hasAnimated, setHasAnimated] = useState(false);
  const prevIdRef = useRef(id);
  // Store the initial text when first mounted - this is usually the first message
  const initialTextRef = useRef(text);

  // Reset state when id changes
  useEffect(() => {
    if (id !== prevIdRef.current) {
      setIsTyping(false);
      setTypedLength(0);
      setHasAnimated(false);
      initialTextRef.current = text;
      prevIdRef.current = id;
    }
  }, [id, text]);

  // Detect when text CHANGES from initial value - trigger typewriter
  useEffect(() => {
    if (hasAnimated) return;

    const textChanged = text !== initialTextRef.current;
    if (isJustCreated && textChanged) {
      setIsTyping(true);
      setTypedLength(1); // Start with first character visible
      setHasAnimated(true);
    }
  }, [text, isJustCreated, hasAnimated]);

  // Typewriter animation
  useEffect(() => {
    if (!isTyping || !text) return;

    if (typedLength < text.length) {
      const timeout = setTimeout(() => {
        setTypedLength((prev) => prev + 1);
      }, 30); // 30ms per character
      return () => clearTimeout(timeout);
    } else {
      setIsTyping(false);
    }
  }, [isTyping, typedLength, text]);

  // If isJustCreated and showPlaceholder and we haven't animated yet AND text is empty - show placeholder
  // Important: if text already has a value, show it immediately (don't wait for animation)
  const hasRealName = text && text !== placeholder && text !== initialTextRef.current;
  const isWaitingForName = isJustCreated && showPlaceholder && !hasAnimated && !hasRealName;

  if (isWaitingForName && !text) {
    return <span className={cn('text-muted-foreground/50', className)}>{placeholder}</span>;
  }

  // Show placeholder for empty text
  if (!text || text === placeholder) {
    if (showPlaceholder) {
      return <span className={cn('text-muted-foreground/50', className)}>{placeholder}</span>;
    }
    return <span className={className}></span>;
  }

  // Not animating - show final text
  if (!isTyping) {
    return <span className={className}>{text}</span>;
  }

  // Typewriter animation in progress
  const visibleText = text.slice(0, typedLength);

  return <span className={className}>{visibleText}</span>;
});
